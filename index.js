const core = require('@actions/core');
const github = require('@actions/github');
const AWS = require('aws-sdk');
const minimatch = require('minimatch');
const path = require('path');
const { BedrockAgentRuntimeWrapper } = require('./bedrock-wrapper');

// Use GITHUB_TOKEN directly from environment variables
const octokit = github.getOctokit(process.env.GITHUB_TOKEN);
const bedrockRuntime = new AWS.BedrockRuntime();
const agentWrapper = new BedrockAgentRuntimeWrapper(bedrockRuntime);

async function main() {
    try {
        const ignorePatterns = core.getInput('ignore_patterns').split(',');
        const actionPrompt = core.getInput('action_prompt');
        const agentId = core.getInput('agent_id');
        const agentAliasId = core.getInput('agent_alias_id');
        const memoryId = core.getInput('memory_id') || null;
        const languageSpecificPrompts = JSON.parse(core.getInput('language_specific_prompts'));
        const githubRepository = process.env.GITHUB_REPOSITORY;
        const prNumber = github.context.payload.pull_request.number;

        if (!githubRepository || !prNumber) {
            core.setFailed("Missing required information to post comment");
            return;
        }

        const [owner, repo] = githubRepository.split('/');
        const { data: prFiles } = await octokit.rest.pulls.listFiles({
            owner,
            repo,
            pull_number: prNumber
        });

        const relevantCode = [];
        const detectedLanguages = new Set();

        prFiles.forEach(file => {
            const filename = file.filename;
            const status = file.status;
            const extension = path.extname(filename).slice(1);

            if (status === 'added' || status === 'modified' || status === 'renamed') {
                const isIgnored = ignorePatterns.some(pattern => minimatch(filename, pattern));
                if (!isIgnored) {
                    relevantCode.push(`File: ${filename} (Status: ${status})\n\n\`\`\`diff\n${file.patch}\n\`\`\`\n\n`);
                    detectedLanguages.add(extension);
                }
            }
        });

        if (relevantCode.length === 0) {
            core.warning("No relevant files found to analyze.");
            return;
        }

        let languageSpecificPrompt = '';
        detectedLanguages.forEach(lang => {
            if (languageSpecificPrompts[lang]) {
                languageSpecificPrompt += `\n${languageSpecificPrompts[lang]}`;
            }
        });

        const sessionId = process.env.GITHUB_RUN_ID;
        const prompt = `${relevantCode.join('')}\n\n${actionPrompt}${languageSpecificPrompt}\n\nFormat your response using Markdown, including appropriate headers and code blocks where relevant.`;

        core.debug(`Generated prompt:\n${prompt}`);

        const agentResponse = await agentWrapper.invokeAgent(agentId, agentAliasId, sessionId, prompt, memoryId);

        const commentBody = formatMarkdownComment(agentResponse, prNumber, relevantCode.length);
        await octokit.rest.issues.createComment({
            owner,
            repo,
            issue_number: prNumber,
            body: commentBody
        });

    } catch (error) {
        core.setFailed(error.message);
    }
}

function formatMarkdownComment(response, prNumber, filesAnalyzed) {
    return `## Analysis for Pull Request #${prNumber}\n\n### Files Analyzed: ${filesAnalyzed}\n\n${response}`;
}

main();
