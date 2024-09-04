const core = require('@actions/core');
const github = require('@actions/github');
const minimatch = require('minimatch');
const { BedrockAgentRuntimeWrapper } = require('./bedrock-wrapper');
const fs = require('fs');
const path = require('path');

const octokit = github.getOctokit(process.env.GITHUB_TOKEN);
const agentWrapper = new BedrockAgentRuntimeWrapper();

async function main() {
    try {
        core.info(`[${getTimestamp()}] Starting GitHub Action`);

        const requiredEnvVars = ['GITHUB_TOKEN', 'GITHUB_REPOSITORY'];
        if (requiredEnvVars.some(varName => !process.env[varName])) {
            core.setFailed(`Error: Missing required environment variables: ${requiredEnvVars.join(', ')}.`);
            return;
        }

        const ignorePatterns = core.getInput('ignore_patterns')
            .split(',').map(pattern => pattern.trim()).filter(Boolean);

        const actionPrompt = core.getInput('action_prompt').trim();
        const agentId = core.getInput('agent_id').trim();
        const agentAliasId = core.getInput('agent_alias_id').trim();
        const debug = core.getBooleanInput('debug');
        const memoryId = core.getInput('memory_id').trim() || undefined;
        const { GITHUB_REPOSITORY: githubRepository } = process.env;
        const { number: prNumber, id: prId } = github.context.payload.pull_request;

        if (!githubRepository || !prNumber || !prId) {
            core.setFailed("Error: Missing required PR information.");
            return;
        }

        const [owner, repo] = githubRepository.split('/');
        core.info(`[${getTimestamp()}] Processing PR #${prNumber} (ID: ${prId}) in repository ${owner}/${repo}`);

        const { data: prFiles } = await octokit.rest.pulls.listFiles({
            owner, repo, pull_number: prNumber
        });
        core.info(`[${getTimestamp()}] Retrieved ${prFiles.length} files from PR #${prNumber}`);

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

        const allIgnorePatterns = [...ignorePatterns, ...gitignorePatterns];
        const { data: comments } = await octokit.rest.issues.listComments({
            owner, repo, issue_number: prNumber
        });

        const relevantCode = [];
        const relevantDiffs = [];
        await Promise.all(prFiles.map(file => processFile(file, allIgnorePatterns, comments, relevantCode, relevantDiffs, owner, repo)));

        if (relevantDiffs.length === 0 && relevantCode.length === 0) {
            core.warning(`[${getTimestamp()}] No relevant files or diffs found for analysis.`);
            return;
        }

        const sessionId = `${prId}-${prNumber}`;
        const diffsPrompt = `Pull Request Diffs:\n${relevantDiffs.join('')}`;
        const prompt = relevantCode.length
            ? `Content of Affected Files:\n${relevantCode.join('')}\nUse the files above to provide context on the changes made in this PR.\n${diffsPrompt}\n${actionPrompt}`
            : `${diffsPrompt}\n${actionPrompt}`;

        if (typeof prompt !== 'string') {
            core.setFailed('Error: The generated prompt is not a valid string.');
            return;
        }

        if (debug) {
            core.info(`[${getTimestamp()}] Generated prompt for Bedrock Agent:\n${prompt}`);
        }

        core.info(`[${getTimestamp()}] Invoking Bedrock Agent with session ID: ${sessionId} and memory ID: ${memoryId}`);
        const agentResponse = await agentWrapper.invokeAgent(agentId, agentAliasId, sessionId, prompt, memoryId);

        if (debug) {
            core.info(`[${getTimestamp()}] Bedrock Agent response:\n${agentResponse}`);
        }

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

async function processFile(file, ignorePatterns, comments, relevantCode, relevantDiffs, owner, repo) {
    const { filename, status } = file;

    if (['added', 'modified', 'renamed'].includes(status) && !ignorePatterns.some(pattern => minimatch(filename, pattern))) {
        if (comments.some(comment => comment.body.includes(filename))) {
            core.info(`[${getTimestamp()}] Skipping file ${filename} as it is already analyzed.`);
            relevantDiffs.push(`File: ${filename} (Status: ${status})\n\`\`\`diff\n${file.patch}\n\`\`\`\n`);
            return;
        }

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

        relevantDiffs.push(`File: ${filename} (Status: ${status})\n\`\`\`diff\n${file.patch}\n\`\`\`\n`);
    }
}

function formatMarkdownComment(response, prNumber, filesAnalyzed, diffsAnalyzed, prFiles) {
    const fileSummary = prFiles
        .map(file => `- **${file.filename}**: ${file.status}`)
        .join('\n');

    return `## Analysis for Pull Request #${prNumber}\n\n### Files Analyzed: ${filesAnalyzed}\n### Diffs Analyzed: ${diffsAnalyzed}\n\n### Files in the PR:\n${fileSummary}\n\n${response}`;
}

function getTimestamp() {
    return new Date().toISOString();
}

main();
