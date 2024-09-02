const { BedrockAgentRuntimeClient, InvokeAgentCommand } = require("@aws-sdk/client-bedrock-agent-runtime");

class BedrockAgentRuntimeWrapper {
    constructor() {
        // Initialize the client without explicit config, relying on the default credential provider chain
        this.client = new BedrockAgentRuntimeClient();
        // Default to tracing disabled
        this.enableTrace = false;
    }

    async invokeAgent(agentId, agentAliasId, sessionId, prompt, memoryId = null, enableTrace = false) {
        const command = new InvokeAgentCommand({
            agentId,
            agentAliasId,
            sessionId,
            inputText: prompt,
            ...(enableTrace ? { enableTrace: true } : {}),
            ...(memoryId ? { memoryId } : {})
        });

        try {
            let completion = "";
            const response = await this.client.send(command);
            
            if (response.completion === undefined) {
                throw new Error("Completion is undefined");
            }

            for await (let chunkEvent of response.completion) {
                const chunk = chunkEvent.chunk;
                const decodedResponse = new TextDecoder("utf-8").decode(chunk.bytes);
                completion += decodedResponse;
            }

            return completion;
        } catch (error) {
            throw new Error(`Failed to invoke Bedrock agent: ${error.message}`);
        }
    }
}

module.exports = { BedrockAgentRuntimeWrapper };
