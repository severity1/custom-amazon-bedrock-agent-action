const core = require('@actions/core');
const github = require('@actions/github');
const minimatch = require('minimatch');
const fs = require('fs');
const path = require('path');
const { BedrockAgentRuntimeWrapper } = require('./bedrock-wrapper');

// Initialize Octokit with the GITHUB_TOKEN from environment variables
const octokit = github.getOctokit(process.env.GITHUB_TOKEN);

// Initialize the Bedrock client with the default AWS SDK configuration
const agentWrapper = new BedrockAgentRuntimeWrapper();

async function main() {
    try {
        // Read inputs from the GitHub Actions workflow
        const actionPrompt = core.getInput('action_prompt');
        const agentId = core.getInput('agent_id');
        const agentAliasId = core.getInput('agent_alias_id');
        const debug = core.getBooleanInput('debug');
        const githubRepository = process.env.GITHUB_REPOSITORY;
        const prNumber = github.context.payload.pull_request.number;

        // Validate necessary information
        if (!githubRepository || !prNumber) {
            core.setFailed("Missing required information to post comment");
            return;
        }

        const [owner, repo] = githubRepository.split('/');
        core.info(`Processing PR #${prNumber} in repository ${owner}/${repo}`);

        // Load and validate ignore patterns from the input
        let ignorePatterns = core.getInput('ignore_patterns')
            .split('\n')
            .map(pattern => pattern.trim())
            .filter(pattern => pattern.length > 0);

        // Validate each ignore pattern
        ignorePatterns = validatePatterns(ignorePatterns, 'ignore_patterns');

        // Load and validate patterns from .gitignore
        const gitignorePath = path.join(process.env.GITHUB_WORKSPACE, '.gitignore');
        let gitIgnorePatterns = [];
        if (fs.existsSync(gitignorePath)) {
            gitIgnorePatterns = fs.readFileSync(gitignorePath, 'utf8')
                .split('\n')
                .map(pattern => pattern.trim())
                .filter(pattern => pattern.length > 0);
            gitIgnorePatterns = validatePatterns(gitIgnorePatterns, '.gitignore');
        }

        // Combine ignore patterns from input and .gitignore
        const allIgnorePatterns = [...ignorePatterns, ...gitIgnorePatterns];

        // Fetch files changed in the pull request
        const { data: prFiles } = await octokit.rest.pulls.listFiles({
            owner,
            repo,
            pull_number: prNumber
        });
        core.info(`Found ${prFiles.length} files in the pull request`);

        // Fetch all comments on the pull request
        const { data: comments } = await octokit.rest.issues.listComments({
            owner,
            repo,
            issue_number: prNumber
        });

        // Identify files already mentioned in previous comments
        const fileNamesInComments = new Set();
        for (const comment of comments) {
            const regex = /\b(\S+?\.\S+)\b:/g;
            let match;
            while ((match = regex.exec(comment.body)) !== null) {
                const filename = match[1].trim();
                fileNamesInComments.add(filename);
            }
        }

        if (debug) {
            core.info(`Filenames already analyzed in previous comments:\n${Array.from(fileNamesInComments).join(', ')}`);
        }

        const relevantCode = [];
        const relevantDiffs = [];
        const fileContents = {};

        // Process each file in the pull request
        for (const file of prFiles) {
            const filename = file.filename;
            const status = file.status;

            // Process files that were added, modified, or renamed
            if (status === 'added' || status === 'modified' || status === 'renamed') {
                const isIgnored = allIgnorePatterns.some(pattern => {
                    // Convert pattern to glob-style matching
                    const matchPattern = pattern.endsWith('/') ? `${pattern}**` : pattern;
                    return minimatch(filename, matchPattern, { matchBase: true });
                });

                if (!isIgnored) {
                    // Check if the file was already analyzed
                    if (!fileNamesInComments.has(filename)) {
                        // Fetch the full content of the file
                        const { data: fileContent } = await octokit.rest.repos.getContent({
                            owner,
                            repo,
                            path: filename
                        });

                        // Add the file content to the analysis list
                        if (fileContent && fileContent.type === 'file') {
                            const content = Buffer.from(fileContent.content, 'base64').toString('utf8');
                            fileContents[filename] = content;
                            relevantCode.push(`### Content of ${filename}\n\`\`\`\n${content}\n\`\`\`\n`);
                            core.info(`File added for analysis: ${filename} (Status: ${status})`);
                        }
                    } else {
                        core.info(`File ${filename} is already analyzed in previous comments. Skipping content analysis.`);
                    }

                    // Collect diffs (changes) for the file
                    relevantDiffs.push(`File: ${filename} (Status: ${status})\n\`\`\`diff\n${file.patch}\n\`\`\`\n`);
                } else {
                    core.info(`File ignored: ${filename} (Status: ${status})`);
                }
            }
        }

        // Exit early if no relevant files or diffs were found
        if (relevantDiffs.length === 0 && relevantCode.length === 0) {
            core.warning("No relevant files found to analyze.");
            return;
        }

        // Use the GitHub run ID as a session ID for invoking the Bedrock agent
        const sessionId = process.env.GITHUB_RUN_ID;

        // Conditionally create codePrompt based on fileNamesInComments
        let codePrompt = '';
        if (fileNamesInComments.size === 0) {
            codePrompt = `## Content of Affected Files:\n\n${relevantCode.join('')}\nUse the files above to provide context on the changes made in this PR.`;
        }
        
        const diffsPrompt = `## Relevant Changes to the PR:\n\n${relevantDiffs.join('')}\n`;

        const prompt = `${codePrompt}\n${diffsPrompt}\n${actionPrompt}\nFormat your response using Markdown, including appropriate headers and code blocks where relevant.`;

        if (debug) {
            core.info(`Generated prompt:\n${prompt}`);
        }

        core.info(`Invoking agent with session ID: ${sessionId}`);

        // Invoke the Bedrock agent with the generated prompt
        const agentResponse = await agentWrapper.invokeAgent(agentId, agentAliasId, sessionId, prompt);

        if (debug) {
            core.info(`Agent response:\n${agentResponse}`);
        }

        core.info(`Posting comment to PR #${prNumber}`);

        // Format the response as a Markdown comment and post it to the PR
        const commentBody = formatMarkdownComment(agentResponse, prNumber, relevantCode.length, relevantDiffs.length, prFiles);
        await octokit.rest.issues.createComment({
            owner,
            repo,
            issue_number: prNumber,
            body: commentBody
        });

        core.info(`Comment successfully posted to PR #${prNumber}`);

    } catch (error) {
        core.setFailed(error.message);
    }
}

// Function to validate patterns
function validatePatterns(patterns, source) {
    const validPatterns = [];
    for (const pattern of patterns) {
        try {
            minimatch.makeRe(pattern); // This will throw an error if the pattern is invalid
            validPatterns.push(pattern);
        } catch (err) {
            core.warning(`Invalid pattern in ${source}: ${pattern}. It will be ignored.`);
        }
    }
    return validPatterns;
}

// Format the response into a Markdown comment
function formatMarkdownComment(response, prNumber, filesAnalyzed, diffsAnalyzed, prFiles) {
    const fileSummary = prFiles
        .map(file => `- **${file.filename}**: ${file.status}`)
        .join('\n');

    return `## Analysis for Pull Request #${prNumber}\n\n### Files Analyzed: ${filesAnalyzed}\n### Diffs Analyzed: ${diffsAnalyzed}\n\n### Files in the PR:\n${fileSummary}\n\n${response}`;
}

// Execute the main function
main();
