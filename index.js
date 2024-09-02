const core = require('@actions/core');
const github = require('@actions/github');
const minimatch = require('minimatch');
const { BedrockAgentRuntimeWrapper } = require('./bedrock-wrapper');
const fs = require('fs');
const path = require('path');

// Initialize Octokit with the GitHub token from environment variables
const octokit = github.getOctokit(process.env.GITHUB_TOKEN);

// Initialize the Bedrock client with the default AWS SDK configuration
const agentWrapper = new BedrockAgentRuntimeWrapper();

async function main() {
    try {
        core.info(`[${getTimestamp()}] Starting GitHub Action`);

        // Validate required environment variables
        if (!process.env.GITHUB_TOKEN || !process.env.GITHUB_REPOSITORY) {
            core.setFailed("Error: Missing required environment variables: GITHUB_TOKEN or GITHUB_REPOSITORY.");
            return;
        }

        // Read and validate inputs from the GitHub Actions workflow
        const ignorePatterns = core.getInput('ignore_patterns')
            .split(',')
            .map(pattern => pattern.trim())
            .filter(Boolean); // Clean up and filter empty patterns

        const actionPrompt = core.getInput('action_prompt').trim();
        const agentId = core.getInput('agent_id').trim();
        const agentAliasId = core.getInput('agent_alias_id').trim();
        const debug = core.getBooleanInput('debug');
        const githubRepository = process.env.GITHUB_REPOSITORY;
        const prNumber = github.context.payload.pull_request.number;
        const prId = github.context.payload.pull_request.id;

        // Validate that repository and PR number are available
        if (!githubRepository || !prNumber || !prId) {
            core.setFailed("Error: Missing required information to post a comment.");
            return;
        }

        const [owner, repo] = githubRepository.split('/');
        core.info(`[${getTimestamp()}] Processing PR #${prNumber} (ID: ${prId}) in repository ${owner}/${repo}`);

        // Fetch files changed in the pull request
        const { data: prFiles } = await octokit.rest.pulls.listFiles({
            owner,
            repo,
            pull_number: prNumber
        });
        core.info(`[${getTimestamp()}] Retrieved ${prFiles.length} files from PR #${prNumber}`);

        // Load `.gitignore` patterns from the checked-out repository
        let gitignorePatterns = [];
        const gitignorePath = path.join(process.env.GITHUB_WORKSPACE, '.gitignore');
        if (fs.existsSync(gitignorePath)) {
            const gitignoreContent = fs.readFileSync(gitignorePath, 'utf-8');
            gitignorePatterns = gitignoreContent
                .split('\n')
                .map(line => line.trim()) // Remove leading/trailing spaces
                .filter(line => line && !line.startsWith('#')); // Exclude comments and empty lines

            if (debug) {
                core.info(`[${getTimestamp()}] Loaded .gitignore patterns:\n${gitignorePatterns.join(', ')}`);
            }
        }

        // Combine ignore patterns with .gitignore patterns
        const allIgnorePatterns = [...ignorePatterns, ...gitignorePatterns];

        // Fetch all comments on the pull request
        const { data: comments } = await octokit.rest.issues.listComments({
            owner,
            repo,
            issue_number: prNumber
        });

        // Initialize lists to collect relevant code and diffs
        const relevantCode = [];
        const relevantDiffs = [];

        // Process each file in the pull request
        await Promise.all(prFiles.map(file => processFile(file, allIgnorePatterns, comments, relevantCode, relevantDiffs, owner, repo)));

        // Exit early if no relevant files or diffs were found
        if (relevantDiffs.length === 0 && relevantCode.length === 0) {
            core.warning(`[${getTimestamp()}] No relevant files or diffs found for analysis.`);
            return;
        }

        // Combine PR id and number to create a session ID
        const sessionId = `${prId}-${prNumber}`;
        const memoryId = `${prId}-${prNumber}`;

        // Conditionally create codePrompt if relevantCode is non-empty
        let codePrompt = '';
        if (relevantCode.length > 0) {
            codePrompt = `## Content of Affected Files:\n\n${relevantCode.join('')}\nUse the files above to provide context on the changes made in this PR.`;
        }

        const diffsPrompt = `## Relevant Changes to the PR:\n\n${relevantDiffs.join('')}\n`;

        const prompt = `${codePrompt}\n${diffsPrompt}\n${actionPrompt}\nFormat your response using Markdown, including appropriate headers and code blocks where relevant.`;

        if (debug) {
            core.info(`[${getTimestamp()}] Generated prompt for Bedrock Agent:\n${prompt}`);
        }

        core.info(`[${getTimestamp()}] Invoking Bedrock Agent with session ID: ${sessionId} and memory ID: ${memoryId}`);

        // Invoke the Bedrock agent with the generated prompt and memory ID
        const agentResponse = await agentWrapper.invokeAgent(agentId, agentAliasId, sessionId, prompt, memoryId);

        if (debug) {
            core.info(`[${getTimestamp()}] Bedrock Agent response:\n${agentResponse}`);
        }

        core.info(`[${getTimestamp()}] Posting analysis comment to PR #${prNumber}`);

        // Format the response as a Markdown comment and post it to the PR
        const commentBody = formatMarkdownComment(agentResponse, prNumber, relevantCode.length, relevantDiffs.length, prFiles);
        await octokit.rest.issues.createComment({
            owner,
            repo,
            issue_number: prNumber,
            body: commentBody
        });

        core.info(`[${getTimestamp()}] Successfully posted comment to PR #${prNumber}`);

    } catch (error) {
        // Log any unexpected errors and fail the action
        core.setFailed(`[${getTimestamp()}] Error: ${error.message}`);
    }
}

// Process each file in the pull request
async function processFile(file, allIgnorePatterns, comments, relevantCode, relevantDiffs, owner, repo) {
    const filename = file.filename;
    const status = file.status;

    // Only process added, modified, or renamed files
    if (['added', 'modified', 'renamed'].includes(status)) {
        // Skip ignored files
        if (allIgnorePatterns.some(pattern => minimatch(filename, pattern))) {
            core.info(`[${getTimestamp()}] Skipping ignored file: ${filename} (Status: ${status})`);
            return;
        }

        // Check if the file's filename is mentioned in any previous comment
        if (comments.some(comment => comment.body.includes(filename))) {
            core.info(`[${getTimestamp()}] Skipping file ${filename} as it is already analyzed in previous comments.`);
            relevantDiffs.push(`File: ${filename} (Status: ${status})\n\`\`\`diff\n${file.patch}\n\`\`\`\n`);
            return;
        }

        try {
            // Fetch the full content of the file
            const { data: fileContent } = await octokit.rest.repos.getContent({
                owner,
                repo,
                path: filename
            });

            if (fileContent?.type === 'file') {
                const content = Buffer.from(fileContent.content, 'base64').toString('utf8');
                relevantCode.push(`### Content of ${filename}\n\`\`\`\n${content}\n\`\`\`\n`);
                core.info(`[${getTimestamp()}] Added file content for analysis: ${filename} (Status: ${status})`);
            }
        } catch (error) {
            core.error(`[${getTimestamp()}] Error fetching content for file ${filename}: ${error.message}`);
        }

        // Collect diffs (changes) for the file
        relevantDiffs.push(`File: ${filename} (Status: ${status})\n\`\`\`diff\n${file.patch}\n\`\`\`\n`);
    }
}

// Format the response into a Markdown comment
function formatMarkdownComment(response, prNumber, filesAnalyzed, diffsAnalyzed, prFiles) {
    const fileSummary = prFiles
        .map(file => `- **${file.filename}**: ${file.status}`)
        .join('\n');

    return `## Analysis for Pull Request #${prNumber}\n\n### Files Analyzed: ${filesAnalyzed}\n### Diffs Analyzed: ${diffsAnalyzed}\n\n### Files in the PR:\n${fileSummary}\n\n${response}`;
}

// Function to format timestamps for logs
function getTimestamp() {
    return new Date().toISOString();
}

// Execute the main function
main();
