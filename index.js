const core = require('@actions/core');
const github = require('@actions/github');
const minimatch = require('minimatch');
const { BedrockAgentRuntimeWrapper } = require('./bedrock-wrapper');
const fs = require('fs');
const path = require('path');

// Initialize GitHub and Bedrock Agent clients
const octokit = github.getOctokit(process.env.GITHUB_TOKEN);
const agentWrapper = new BedrockAgentRuntimeWrapper();

async function main() {
    try {
        core.info(`[${getTimestamp()}] Starting GitHub Action`);

        // Ensure required environment variables are set
        const requiredEnvVars = ['GITHUB_TOKEN', 'GITHUB_REPOSITORY'];
        if (requiredEnvVars.some(varName => !process.env[varName])) {
            core.setFailed(`Error: Missing required environment variables: ${requiredEnvVars.join(', ')}.`);
            return;
        }

        // Extract payload from GitHub context
        const payload = github.context.payload;

        // Parse inputs from the GitHub Action workflow
        const ignorePatterns = core.getInput('ignore_patterns')
            .split(',').map(pattern => pattern.trim()).filter(Boolean);

        const actionPrompt = core.getInput('action_prompt').trim();
        const agentId = core.getInput('agent_id').trim();
        const agentAliasId = core.getInput('agent_alias_id').trim();
        const debug = core.getBooleanInput('debug');
        const memoryId = core.getInput('memory_id').trim() || undefined;

        // Extract PR information from the GitHub context
        const { GITHUB_REPOSITORY: githubRepository } = process.env;
        const { number: prNumber, id: prId } = payload.pull_request;

        if (!githubRepository || !prNumber || !prId) {
            core.setFailed("Error: Missing required PR information.");
            return;
        }

        // Parse repository owner and name
        const [owner, repo] = githubRepository.split('/');
        core.info(`[${getTimestamp()}] Processing PR #${prNumber} (ID: ${prId}) in repository ${owner}/${repo}`);

        // Generate a unique session ID for the PR
        const sessionId = `${prId}-${prNumber}`;

        // Check if the PR is being closed or merged
        const action = payload.action;
        if (action === 'closed') {
            await handleClosedPR(agentId, agentAliasId, sessionId);
            return;
        }

        // Fetch the list of files changed in the PR
        const { data: prFiles } = await octokit.rest.pulls.listFiles({
            owner, repo, pull_number: prNumber
        });
        core.info(`[${getTimestamp()}] Retrieved ${prFiles.length} files from PR #${prNumber}`);

        // Load patterns from .gitignore if it exists
        let gitignorePatterns = [];
        const gitignorePath = path.join(process.env.GITHUB_WORKSPACE, '.gitignore');
        if (fs.existsSync(gitignorePath)) {
            gitignorePatterns = fs.readFileSync(gitignorePath, 'utf-8')
                .split('\n').map(line => line.trim())
                .filter(line => line && !line.startsWith('#'));

            if (debug) {
                core.info(`[${getTimestamp()}] Loaded .gitignore patterns:\n${gitignorePatterns.join(', ')}`);
            }
        }

        // Combine ignore patterns from both the input and .gitignore
        const allIgnorePatterns = [...ignorePatterns, ...gitignorePatterns];

        // Fetch existing comments on the PR
        const { data: comments } = await octokit.rest.issues.listComments({
            owner, repo, issue_number: prNumber
        });

        // Initialize arrays to store relevant code and diffs
        const relevantCode = [];
        const relevantDiffs = [];
        await Promise.all(prFiles.map(file => processFile(file, allIgnorePatterns, comments, relevantCode, relevantDiffs, owner, repo)));

        // Check if there are any relevant code or diffs to analyze
        if (relevantDiffs.length === 0 && relevantCode.length === 0) {
            core.warning(`[${getTimestamp()}] No relevant files or diffs found for analysis.`);
            return;
        }

        // Prepare the prompt for the Bedrock Agent
        const diffsPrompt = `Pull Request Diffs:\n${relevantDiffs.join('')}`;
        const prompt = relevantCode.length
            ? `Content of Affected Files:\n${relevantCode.join('')}\nUse the files above to provide context on the changes made in this PR.\n${diffsPrompt}\n${actionPrompt}`
            : `${diffsPrompt}\n${actionPrompt}`;

        // Validate the prompt before proceeding
        if (typeof prompt !== 'string') {
            core.setFailed('Error: The generated prompt is not a valid string.');
            return;
        }

        if (debug) {
            core.info(`[${getTimestamp()}] Generated prompt for Bedrock Agent:\n${prompt}`);
        }

        // Invoke the Bedrock Agent with the generated prompt
        core.info(`[${getTimestamp()}] Invoking Bedrock Agent with session ID: ${sessionId} and memory ID: ${memoryId}`);
        const agentResponse = await agentWrapper.invokeAgent(agentId, agentAliasId, sessionId, prompt, memoryId);

        if (debug) {
            core.info(`[${getTimestamp()}] Bedrock Agent response:\n${agentResponse}`);
        }

        // Post the agent's response as a comment on the PR
        core.info(`[${getTimestamp()}] Posting analysis comment to PR #${prNumber}`);
        const commentBody = formatMarkdownComment(agentResponse, prNumber, relevantCode.length, relevantDiffs.length, prFiles);
        await octokit.rest.issues.createComment({
            owner, repo, issue_number: prNumber, body: commentBody
        });

        core.info(`[${getTimestamp()}] Successfully posted comment to PR #${prNumber}`);
    } catch (error) {
        core.setFailed(`[${getTimestamp()}] Error: ${error.message}`);
    }
}

async function handleClosedPR(agentId, agentAliasId, sessionId) {
    try {
        core.info(`[${getTimestamp()}] PR is being closed or merged. Ending Bedrock Agent session.`);
        await agentWrapper.invokeAgent(agentId, agentAliasId, sessionId, endSession = true);
        core.info(`[${getTimestamp()}] Successfully ended Bedrock Agent session for PR.`);
    } catch (error) {
        core.error(`[${getTimestamp()}] Error ending Bedrock Agent session: ${error.message}`);
    }
}

// Process each file in the PR to check if it should be analyzed
async function processFile(file, ignorePatterns, comments, relevantCode, relevantDiffs, owner, repo) {
    const { filename, status } = file;

    // Only process added, modified, or renamed files that don't match ignore patterns
    if (['added', 'modified', 'renamed'].includes(status) && !ignorePatterns.some(pattern => minimatch(filename, pattern))) {
        // Skip analysis if the file has already been commented on
        if (comments.some(comment => comment.body.includes(filename))) {
            core.info(`[${getTimestamp()}] Skipping file ${filename} as it is already analyzed.`);
            relevantDiffs.push(`File: ${filename} (Status: ${status})\n\`\`\`diff\n${file.patch}\n\`\`\`\n`);
            return;
        }

        // Attempt to fetch the file content for analysis
        try {
            const { data: fileContent } = await octokit.rest.repos.getContent({ owner, repo, path: filename });
            if (fileContent?.type === 'file') {
                const content = Buffer.from(fileContent.content, 'base64').toString('utf8');
                relevantCode.push(`Content of ${filename}\n\`\`\`\n${content}\n\`\`\`\n`);
                core.info(`[${getTimestamp()}] Added file content for analysis: ${filename} (Status: ${status})`);
            }
        } catch (error) {
            core.error(`[${getTimestamp()}] Error fetching content for file ${filename}: ${error.message}`);
        }

        // Store the diff for the file
        relevantDiffs.push(`File: ${filename} (Status: ${status})\n\`\`\`diff\n${file.patch}\n\`\`\`\n`);
    }
}

// Format the agent's response as a Markdown comment for the PR
function formatMarkdownComment(response, prNumber, filesAnalyzed, diffsAnalyzed, prFiles) {
    const fileSummary = prFiles
        .map(file => `- **${file.filename}**: ${file.status}`)
        .join('\n');

    return `## Analysis for Pull Request #${prNumber}\n\n### Files Analyzed: ${filesAnalyzed}\n### Diffs Analyzed: ${diffsAnalyzed}\n\n### Files in the PR:\n${fileSummary}\n\n${response}`;
}

// Get the current timestamp in ISO format
function getTimestamp() {
    return new Date().toISOString();
}

// Start the GitHub Action
main();
