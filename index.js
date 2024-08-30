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

        const { data: prFiles } = await octokit.rest.pulls.listFiles({
            owner,
            repo,
            pull_number: prNumber
        });

        core.info(`Found ${prFiles.length} files in the pull request`);

        const relevantCode = [];

        prFiles.forEach(file => {
            const filename = file.filename;
            const status = file.status;

            if (status === 'added' || status === 'modified' || status === 'renamed') {
                const isIgnored = ignorePatterns.some(pattern => minimatch(filename, pattern));
                if (!isIgnored) {
                    relevantCode.push(`File: ${filename} (Status: ${status})\n\n\`\`\`diff\n${file.patch}\n\`\`\`\n\n`);
                    core.info(`File added for analysis: ${filename} (Status: ${status})`);
                } else {
                    core.info(`File ignored: ${filename} (Status: ${status})`);
                }
            }
        });

        if (relevantCode.length === 0) {
            core.warning("No relevant files found to analyze.");
            return;
        }

        const sessionId = process.env.GITHUB_RUN_ID;
        const prompt = `${relevantCode.join('')}\n\n${actionPrompt}\n\nFormat your response using Markdown, including appropriate headers and code blocks where relevant.`;

        if (debug) {
            core.info(`Generated prompt:\n${prompt}`);
        }

        core.info(`Invoking agent with session ID: ${sessionId}`);

        const agentResponse = await agentWrapper.invokeAgent(agentId, agentAliasId, sessionId, prompt);

        if (debug) {
            core.info(`Agent response:\n${agentResponse}`);
        }

        core.info(`Posting comment to PR #${prNumber}`);

        const commentBody = formatMarkdownComment(agentResponse, prNumber, relevantCode.length);
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

function formatMarkdownComment(response, prNumber, filesAnalyzed) {
    return `## Analysis for Pull Request #${prNumber}\n\n### Files Analyzed: ${filesAnalyzed}\n\n${response}`;
}

main();
