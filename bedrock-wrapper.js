const core = require('@actions/core');
const { BedrockAgentRuntimeClient, InvokeAgentCommand } = require("@aws-sdk/client-bedrock-agent-runtime");

// Wrapper class for interacting with Bedrock Agent Runtime
class BedrockAgentRuntimeWrapper {
    constructor() {
        // Initialize the BedrockAgentRuntimeClient using the default credential provider chain
        this.client = new BedrockAgentRuntimeClient();
    }

    /**
     * Invokes a Bedrock agent with the provided parameters.
     * 
     * @param {string} agentId - The ID of the Bedrock agent to invoke.
     * @param {string} agentAliasId - The alias ID for the agent.
     * @param {string} sessionId - The session ID for tracking the interaction.
     * @param {string} prompt - The input text to be processed by the agent.
     * @param {string} [memoryId] - The memory ID for persisting the session state. Optional.
     * @param {boolean} [endSession=false] - Whether to end the session after this invocation. Optional.
     * @returns {Promise<string>} - The completion response from the agent.
     * @throws {Error} - Throws an error if invocation fails or completion is undefined.
     */
    async invokeAgent(agentId, agentAliasId, sessionId, prompt, memoryId, endSession = false) {
        // Determine the input text based on the endSession flag
        const inputText = endSession ? "Goodbye." : prompt;

        // Create a new command to invoke the agent
        const command = new InvokeAgentCommand({
            agentId,
            agentAliasId,
            sessionId,
            inputText,
            ...(memoryId && { memoryId }), // Add memoryId only if it's provided
            endSession // Set endSession if true
        });

        try {
            let completion = "";
            // Send the command to the Bedrock agent client and await the response
            const response = await this.client.send(command);
            
            // Check if the completion property exists in the response
            if (!response.completion) {
                core.error(`[${getTimestamp()}] Error: Completion is undefined`);
                throw new Error("Completion is undefined");
            }

            // Process each chunk of the completion response
            for await (let chunkEvent of response.completion) {
                const chunk = chunkEvent.chunk;
                // Decode the chunk bytes to UTF-8 string
                const decodedResponse = new TextDecoder("utf-8").decode(chunk.bytes);
                completion += decodedResponse;
            }

            // Log if the session was ended
            if (endSession) {
                core.info(`[${getTimestamp()}] Session ended successfully for agent ${agentId}, session ${sessionId}`);
            }

            return completion;
        } catch (error) {
            // Log error and throw a new error if invocation fails
            core.error(`[${getTimestamp()}] Error: Failed to invoke Bedrock agent: ${error.message}`);
            throw new Error(`Error: Failed to invoke Bedrock agent: ${error.message}`);
        }
    }
}

// Utility function to get the current timestamp in ISO format
function getTimestamp() {
    return new Date().toISOString();
}

// Export the wrapper class for use in other modules
module.exports = { BedrockAgentRuntimeWrapper };
