const core = require('@actions/core');
const github = require('@actions/github');
const minimatch = require('minimatch');
const { BedrockAgentRuntimeWrapper } = require('./bedrock-wrapper');

// Use GITHUB_TOKEN directly from environment variables
const octokit = github.getOctokit(process.env.GITHUB_TOKEN);

// Initialize the Bedrock client with the default AWS SDK configuration
const agentWrapper = new BedrockAgentRuntimeWrapper();

async function main() {
    try {
        const ignorePatterns = core.getInput('ignore_patterns').split(',');
        const actionPrompt = core.getInput('action_prompt');
        const agentId = core.getInput('agent_id');
        const agentAliasId = core.getInput('agent_alias_id');
        const debug = core.getBooleanInput('debug'); // Read the debug input
        const githubRepository = process.env.GITHUB_REPOSITORY;
        const prNumber = github.context.payload.pull_request.number;

        if (!githubRepository || !prNumber) {
            core.setFailed("Missing required information to post comment");
            return;
        }

        const [owner, repo] = githubRepository.split('/');
        core.info(`Processing PR #${prNumber} in repository ${owner}/${repo}`);

        // Fetch files in the pull request
        const { data: prFiles } = await octokit.rest.pulls.listFiles({
            owner,
            repo,
            pull_number: prNumber
        });

        core.info(`Found ${prFiles.length} files in the pull request`);

        // Fetch existing comments from the bot
        const { data: comments } = await octokit.rest.issues.listComments({
            owner,
            repo,
            issue_number: prNumber
        });

        const botUser = github.context.actor; // Bot user who created the comments
        const fileNamesInComments = new Set();
        comments.forEach(comment => {
            if (comment.user.login === botUser) {
                const regex = /### Content of ([^\n]+)\n\n```/g;
                let match;
                while ((match = regex.exec(comment.body)) !== null) {
                    const filename = match[1].trim();
                    fileNamesInComments.add(filename);
                }
            }
        });

        if (debug) {
            core.info(`Filenames in comment:\n${fileNamesInComments}`);
        }

        const relevantCode = [];
        const relevantDiffs = [];
        const fileContents = {};

        // Process files in the PR
        for (const file of prFiles) {
            const filename = file.filename;
            const status = file.status;

            if (status === 'added' || status === 'modified' || status === 'renamed') {
                const isIgnored = ignorePatterns.some(pattern => minimatch(filename, pattern));
                
                if (!isIgnored) {
                    if (!fileNamesInComments.has(filename)) {
                        // Fetch full content for new files
                        const { data: fileContent } = await octokit.rest.repos.getContent({
                            owner,
                            repo,
                            path: filename
                        });

                        if (fileContent && fileContent.type === 'file') {
                            const content = Buffer.from(fileContent.content, 'base64').toString('utf8');
                            fileContents[filename] = content;
                            relevantCode.push(`### Content of ${filename}\n\`\`\`\n${content}\n\`\`\`\n`);
                            core.info(`File added for analysis: ${filename} (Status: ${status})`);
                        }
                    } else {
                        core.info(`File ${filename} is already analyzed in previous comments. Skipping content analysis.`);
                    }

                    // Collect relevant diffs
                    relevantDiffs.push(`File: ${filename} (Status: ${status})\n\`\`\`diff\n${file.patch}\n\`\`\`\n`);
                } else {
                    core.info(`File ignored: ${filename} (Status: ${status})`);
                }
            }
        }

        if (relevantDiffs.length === 0 && relevantCode.length === 0) {
            core.warning("No relevant files found to analyze.");
            return;
        }

        const sessionId = process.env.GITHUB_RUN_ID;

        // Create prompts for relevant code and diffs
        const codePrompt = `## Content of Affected Files:\n\n${relevantCode.join('')}\n`;
        const diffsPrompt = `## Relevant Changes to the PR:\n\n${relevantDiffs.join('')}\n`;

        const prompt = `${codePrompt}       
Use the files above to provide context on the changes made in this PR.

${diffsPrompt}
The diffs above contain the changes made in the PR.
            
${actionPrompt}        
Format your response using Markdown, including appropriate headers and code blocks where relevant.`;

        if (debug) {
            core.info(`Generated prompt:\n${prompt}`);
        }

        core.info(`Invoking agent with session ID: ${sessionId}`);

        const agentResponse = await agentWrapper.invokeAgent(agentId, agentAliasId, sessionId, prompt);

        if (debug) {
            core.info(`Agent response:\n${agentResponse}`);
        }

        core.info(`Posting comment to PR #${prNumber}`);

        const commentBody = formatMarkdownComment(agentResponse, prNumber, relevantCode.length, relevantDiffs.length);
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

function formatMarkdownComment(response, prNumber, filesAnalyzed, diffsAnalyzed) {
    return `## Analysis for Pull Request #${prNumber}\n\n### Files Analyzed: ${filesAnalyzed}\n### Diffs Analyzed: ${diffsAnalyzed}\n\n${response}`;
}

main();
