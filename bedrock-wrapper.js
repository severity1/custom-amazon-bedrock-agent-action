class BedrockAgentRuntimeWrapper {
    constructor(client) {
        this.client = client;
    }

    async invokeAgent(agentId, agentAliasId, sessionId, prompt, memoryId = null) {
        const maxPromptLength = 24000;
        const truncatedPrompt = prompt.length > maxPromptLength ? prompt.slice(0, maxPromptLength) + "..." : prompt;

        const params = {
            agentId,
            agentAliasId,
            sessionId,
            inputText: truncatedPrompt,
            enableTrace: false,
            endSession: false,
            ...(memoryId ? { memoryId } : {})
        };

        try {
            const response = await this.client.invoke_agent(params).promise();
            return response.bytes;
        } catch (error) {
            throw new Error(`Failed to invoke Bedrock agent: ${error.message}`);
        }
    }
}

module.exports = { BedrockAgentRuntimeWrapper };