const { BedrockAgentRuntimeClient, InvokeAgentCommand } = require("@aws-sdk/client-bedrock-agent-runtime");

class BedrockAgentRuntimeWrapper {
    constructor() {
        // Initialize the client without explicit config, relying on the default credential provider chain
        this.client = new BedrockAgentRuntimeClient();
    }

    async invokeAgent(agentId, agentAliasId, sessionId, prompt, memoryId = null) {
        const command = new InvokeAgentCommand({
            agentId,
            agentAliasId,
            sessionId,
            inputText: prompt,
            ...(memoryId ? { memoryId } : {})
        });
    
        try {
            console.log(`Invoking agent with parameters:
                Agent ID: ${agentId},
                Agent Alias ID: ${agentAliasId},
                Session ID: ${sessionId},
                Memory ID: ${memoryId},
                Prompt: ${prompt}`);
    
            let completion = "";
            const response = await this.client.send(command);
            
            console.log(`Response received: ${JSON.stringify(response)}`);
    
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
            console.error(`Error invoking agent: ${error.message}`);
            throw new Error(`Failed to invoke Bedrock agent: ${error.message}`);
        }
    }    
}

module.exports = { BedrockAgentRuntimeWrapper };
