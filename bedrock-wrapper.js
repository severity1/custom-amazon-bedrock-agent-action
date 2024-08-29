const { BedrockRuntimeClient, InvokeModelCommand } = require("@aws-sdk/client-bedrock-runtime");

class BedrockAgentRuntimeWrapper {
    constructor(config) {
        this.client = new BedrockRuntimeClient(config);
    }

    async invokeAgent(agentId, agentAliasId, sessionId, prompt, memoryId = null) {
        const maxPromptLength = 24000;
        const truncatedPrompt = prompt.length > maxPromptLength ? prompt.slice(0, maxPromptLength) + "..." : prompt;

        const params = {
            modelId: `agent/${agentId}/${agentAliasId}`,
            contentType: "application/json",
            accept: "application/json",
            body: JSON.stringify({
                sessionId,
                inputText: truncatedPrompt,
                enableTrace: false,
                endSession: false,
                ...(memoryId ? { memoryId } : {})
            })
        };

        try {
            const command = new InvokeModelCommand(params);
            const response = await this.client.send(command);
            return JSON.parse(new TextDecoder().decode(response.body));
        } catch (error) {
            throw new Error(`Failed to invoke Bedrock agent: ${error.message}`);
        }
    }
}

module.exports = { BedrockAgentRuntimeWrapper };
