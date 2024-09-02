// custom-amazon-bedrock-agent-action/bedrock-wrapper.js

const core = require('@actions/core');
const { BedrockAgentRuntimeClient, InvokeAgentCommand } = require("@aws-sdk/client-bedrock-agent-runtime");

class BedrockAgentRuntimeWrapper {
    constructor() {
        // Initialize the client without explicit config, relying on the default credential provider chain
        this.client = new BedrockAgentRuntimeClient();
    }

    async invokeAgent(agentId, agentAliasId, sessionId, prompt, memoryId) {
        const command = new InvokeAgentCommand({
            agentId,
            agentAliasId,
            sessionId,
            inputText: prompt,
            memoryId,
            enableTrace: true,
        });

        try {
            let completion = "";
            const response = await this.client.send(command);
            
            if (!response.completion) {
                core.error(`[${getTimestamp()}] Error: Completion is undefined`);
                throw new Error("Completion is undefined");
            }

            for await (let chunkEvent of response.completion) {
                const chunk = chunkEvent.chunk;
                const decodedResponse = new TextDecoder("utf-8").decode(chunk.bytes);
                completion += decodedResponse;
            }

            return completion;
        } catch (error) {
            core.error(`[${getTimestamp()}] Error: Failed to invoke Bedrock agent: ${error.message}`);
            throw new Error(`Error: Failed to invoke Bedrock agent: ${error.message}`);
        }
    }
}

function getTimestamp() {
    return new Date().toISOString();
}

module.exports = { BedrockAgentRuntimeWrapper };
