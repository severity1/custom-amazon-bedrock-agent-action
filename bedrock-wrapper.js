const { BedrockAgentRuntimeClient, InvokeAgentCommand } = require("@aws-sdk/client-bedrock-agent-runtime");
const { BedrockAgentClient, GetAgentKnowledgeBaseCommand } = require("@aws-sdk/client-bedrock-agent");
const core = require('@actions/core');

class BedrockAgentRuntimeWrapper {
    constructor() {
        // Initialize the Bedrock Agent Runtime client
        this.runtimeClient = new BedrockAgentRuntimeClient();
        // Initialize the Bedrock Agent client for knowledgebase queries
        this.agentClient = new BedrockAgentClient();
        core.info("BedrockAgentRuntimeWrapper initialized.");
    }

    // Method to get the list of knowledgebases associated with the agent
    async getKnowledgebases(agentId) {
        try {
            core.info(`Fetching knowledgebases for Agent ID: ${agentId}`);
            const command = new GetAgentKnowledgeBaseCommand({ agentId });
            const response = await this.agentClient.send(command);

            core.info(`Knowledgebase details for Agent ID ${agentId}: ${JSON.stringify(response)}`);

            const knowledgebases = response.knowledgeBaseList || [];

            if (knowledgebases.length > 0) {
                core.info(`Knowledgebases found for Agent ID ${agentId}: ${knowledgebases.join(', ')}`);
            } else {
                core.info(`No knowledgebases associated with Agent ID ${agentId}`);
            }

            return knowledgebases;
        } catch (error) {
            core.error(`Failed to fetch knowledgebases for Agent ID ${agentId}: ${error.message}`);
            throw new Error(`Failed to get knowledgebases for agent: ${error.message}`);
        }
    }

    async invokeAgent(agentId, agentAliasId, sessionId, prompt, memoryId = null) {
        core.info(`Preparing to invoke agent with the following details: 
            Agent ID: ${agentId},
            Agent Alias ID: ${agentAliasId},
            Session ID: ${sessionId},
            Memory ID: ${memoryId ? memoryId : 'None'},
            Prompt: "${prompt}"`);

        const command = new InvokeAgentCommand({
            agentId,
            agentAliasId,
            sessionId,
            inputText: prompt,
            ...(memoryId ? { memoryId } : {})
        });

        try {
            const response = await this.runtimeClient.send(command);
            core.info(`Agent invocation response received: ${JSON.stringify(response)}`);

            if (response.completion === undefined) {
                throw new Error("Completion is undefined in the response.");
            }

            let completion = "";
            for await (let chunkEvent of response.completion) {
                const chunk = chunkEvent.chunk;
                const decodedResponse = new TextDecoder("utf-8").decode(chunk.bytes);
                completion += decodedResponse;
            }

            core.info(`Agent completed the prompt processing with the following completion: "${completion}"`);
            return completion;
        } catch (error) {
            core.error(`Failed to invoke agent with Agent ID ${agentId}: ${error.message}`);
            throw new Error(`Failed to invoke Bedrock agent: ${error.message}`);
        }
    }
}

module.exports = { BedrockAgentRuntimeWrapper };
