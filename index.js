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
        const eventName = github.context.eventName;
        if (debug) {
            core.info(`[${getTimestamp()}] ${eventName}`);
        }
        const payload = github.context.payload;
        if (debug) {
            core.info(`[${getTimestamp()}] ${payload}`);
        }

        // Parse inputs from the GitHub Action workflow
        const ignorePatterns = core.getInput('ignore_patterns')
            .split(',').map(pattern => pattern.trim()).filter(Boolean);

        const actionPrompt = core.getInput('action_prompt').trim();
        const agentId = core.getInput('agent_id').trim();
        const agentAliasId = core.getInput('agent_alias_id').trim();
        const debug = core.getBooleanInput('debug');
        const memoryId = core.getInput('memory_id').trim() || undefined;

        // Extract repository information
        const { GITHUB_REPOSITORY: githubRepository } = process.env;
        const [owner, repo] = githubRepository.split('/');

        let sessionId, changedFiles, comments = [];

        if (eventName === 'pull_request') {
            // Handle pull request event
            const { number: prNumber, id: prId } = payload.pull_request;
            sessionId = `pr-${prId}-${prNumber}`;
            core.info(`[${getTimestamp()}] Processing PR #${prNumber} (ID: ${prId}) in repository ${owner}/${repo}`);

            // Check if the PR is being closed or merged
            if (payload.action === 'closed') {
                await handleClosedPR(agentId, agentAliasId, sessionId);
                return;
            }

            // Fetch the list of files changed in the PR
            const { data: prFiles } = await octokit.rest.pulls.listFiles({
                owner, repo, pull_number: prNumber
            });
            changedFiles = prFiles;

            // Fetch existing comments on the PR
            const { data: prComments } = await octokit.rest.issues.listComments({
                owner, repo, issue_number: prNumber
            });
            comments = prComments;
        } else if (eventName === 'push') {
            // Handle push event
            const pushId = payload.after;
            sessionId = `push-${pushId}`;
            core.info(`[${getTimestamp()}] Processing push (ID: ${pushId}) in repository ${owner}/${repo}`);

            // Fetch the list of files changed in the push
            const { data: pushCommit } = await octokit.rest.repos.getCommit({
                owner, repo, ref: pushId
            });
            changedFiles = pushCommit.files;
        } else {
            core.setFailed(`Unsupported event type: ${eventName}`);
            return;
        }

        core.info(`[${getTimestamp()}] Retrieved ${changedFiles.length} changed files`);

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

        // Initialize arrays to store relevant code and diffs
        const relevantCode = [];
        const relevantDiffs = [];
        await Promise.all(changedFiles.map(file => processFile(file, allIgnorePatterns, relevantCode, relevantDiffs, owner, repo, eventName, comments)));

        // Check if there are any relevant code or diffs to analyze
        if (relevantDiffs.length === 0 && relevantCode.length === 0) {
            core.warning(`[${getTimestamp()}] No relevant files or diffs found for analysis.`);
            return;
        }

        // Prepare the prompt for the Bedrock Agent
        const diffsPrompt = `Changes:\n${relevantDiffs.join('')}`;
        const prompt = relevantCode.length
            ? `Content of Affected Files:\n${relevantCode.join('')}\nUse the files above to provide context on the changes made.\n${diffsPrompt}\n${actionPrompt}`
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

        // Post the agent's response as a comment for PR or print for other events
        if (eventName === 'pull_request') {
            core.info(`[${getTimestamp()}] Posting analysis comment to PR #${payload.pull_request.number}`);
            const commentBody = formatMarkdownComment(agentResponse, payload.pull_request.number, relevantCode.length, relevantDiffs.length, changedFiles);
            await octokit.rest.issues.createComment({
                owner, repo, issue_number: payload.pull_request.number, body: commentBody
            });
            core.info(`[${getTimestamp()}] Successfully posted comment to PR #${payload.pull_request.number}`);
        } else {
            core.info(`[${getTimestamp()}] Printing analysis for ${eventName} event`);
            const analysisOutput = formatMarkdownAnalysis(agentResponse, payload.after, relevantCode.length, relevantDiffs.length, changedFiles);
            console.info(analysisOutput);
            core.info(`[${getTimestamp()}] Analysis output printed to console`);
        }
    } catch (error) {
        core.setFailed(`[${getTimestamp()}] Error: ${error.message}`);
    }
}

async function handleClosedPR(agentId, agentAliasId, sessionId) {
    const endSession = true; // Set to true if you want to end the session
    const prompt = "Goodbye.";
    try {
        core.info(`[${getTimestamp()}] PR is being closed or merged. Ending Bedrock Agent session.`);
        await agentWrapper.invokeAgent(agentId, agentAliasId, sessionId, prompt, undefined, endSession);
        core.info(`[${getTimestamp()}] Successfully ended Bedrock Agent session for PR.`);
    } catch (error) {
        core.error(`[${getTimestamp()}] Error ending Bedrock Agent session: ${error.message}`);
    }
}


// Process each file in the PR or Push event to check if it should be analyzed
async function processFile(file, ignorePatterns, relevantCode, relevantDiffs, owner, repo, eventName, comments = []) {
    const { filename, status } = file;

    // Only process added, modified, or renamed files that don't match ignore patterns
    if (['added', 'modified', 'renamed'].includes(status) && !ignorePatterns.some(pattern => minimatch(filename, pattern))) {
        if (eventName === 'pull_request') {
            // Skip analysis if the file has already been commented on (only for pull requests)
            if (comments.some(comment => comment.body.includes(filename))) {
                core.info(`[${getTimestamp()}] Skipping file ${filename} as it is already analyzed.`);
                relevantDiffs.push(`File: ${filename} (Status: ${status})\n\`\`\`diff\n${file.patch}\n\`\`\`\n`);
                return;
            }
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
        if (file.patch) {
            relevantDiffs.push(`File: ${filename} (Status: ${status})\n\`\`\`diff\n${file.patch}\n\`\`\`\n`);
        } else {
            relevantDiffs.push(`File: ${filename} (Status: ${status})\n`);
        }
    }
}

// Format the agent's response as a Markdown comment for the PR
function formatMarkdownComment(response, prNumber, filesAnalyzed, diffsAnalyzed, prFiles) {
    const fileSummary = prFiles
        .map(file => `- **${file.filename}**: ${file.status}`)
        .join('\n');

    return `## Analysis for Pull Request #${prNumber}\n\n### Files Analyzed: ${filesAnalyzed}\n### Diffs Analyzed: ${diffsAnalyzed}\n\n### Files in the PR:\n${fileSummary}\n\n${response}`;
}

// Add a new function to format the issue for push events
function formatMarkdownAnalysis(response, commitSha, filesAnalyzed, diffsAnalyzed, changedFiles) {
    const fileSummary = changedFiles
        .map(file => `- **${file.filename}**: ${file.status}`)
        .join('\n');

    return `## Analysis for Push (Commit: ${commitSha.substring(0, 7)})\n\n### Files Analyzed: ${filesAnalyzed}\n### Diffs Analyzed: ${diffsAnalyzed}\n\n### Files Changed:\n${fileSummary}\n\n${response}`;
}

// Get the current timestamp in ISO format
function getTimestamp() {
    return new Date().toISOString();
}

// Start the GitHub Action
main();
