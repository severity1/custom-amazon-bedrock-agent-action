const { BedrockAgentRuntimeClient, InvokeAgentCommand } = require("@aws-sdk/client-bedrock-agent-runtime");
const { BedrockAgentClient, ListAgentKnowledgeBasesCommand, GetAgentAliasCommand } = require("@aws-sdk/client-bedrock-agent");
const core = require('@actions/core');

class BedrockAgentRuntimeWrapper {
    constructor() {
        // Initialize the Bedrock Agent Runtime client
        this.runtimeClient = new BedrockAgentRuntimeClient();
        // Initialize the Bedrock Agent client for knowledgebase and alias queries
        this.agentClient = new BedrockAgentClient();
        core.info("BedrockAgentRuntimeWrapper initialized.");
    }

    // Method to get the agent version from the agentAliasId
    async getAgentVersion(agentId, agentAliasId) {
        try {
            core.info(`Fetching agent version for Agent ID: ${agentId} and Agent Alias ID: ${agentAliasId}`);
            const command = new GetAgentAliasCommand({ agentId, agentAliasId });
            const response = await this.agentClient.send(command);

            core.info(`Agent alias details: ${JSON.stringify(response)}`);

            const agentVersion = response.agentAlias?.agentVersion;

            if (agentVersion) {
                core.info(`Agent Version for Alias ID ${agentAliasId}: ${agentVersion}`);
                return agentVersion;
            } else {
                core.warning(`No agent version found for Agent Alias ID ${agentAliasId}`);
                throw new Error(`Agent version not found for Alias ID ${agentAliasId}`);
            }
        } catch (error) {
            core.error(`Failed to fetch agent version for Agent ID ${agentId} and Agent Alias ID ${agentAliasId}: ${error.message}`);
            throw new Error(`Failed to get agent version: ${error.message}`);
        }
    }

    // Method to get the list of enabled knowledgebases associated with the agent
    async getKnowledgebases(agentId, agentAliasId) {
        try {
            // Get the agent version from the agentAliasId
            const agentVersion = await this.getAgentVersion(agentId, agentAliasId);

            core.info(`Fetching knowledgebases for Agent Version: ${agentVersion}`);
            const command = new ListAgentKnowledgeBasesCommand({ agentId, agentVersion });
            const response = await this.agentClient.send(command);

            core.info(`Knowledgebase details for Agent Alias ID ${agentAliasId}: ${JSON.stringify(response)}`);

            // Extract knowledgebase summaries from the response
            const knowledgebaseSummaries = response.agentKnowledgeBaseSummaries || [];
            
            // Filter and extract IDs of enabled knowledgebases
            const enabledKnowledgebases = knowledgebaseSummaries
                .filter(kb => kb.knowledgeBaseState === 'ENABLED')
                .map(kb => kb.knowledgeBaseId);

            if (enabledKnowledgebases.length > 0) {
                core.info(`Enabled knowledgebases found for Agent Alias ID ${agentAliasId}: ${enabledKnowledgebases.join(', ')}`);
            } else {
                core.info(`No enabled knowledgebases associated with Agent Alias ID ${agentAliasId}`);
            }

            return enabledKnowledgebases;
        } catch (error) {
            core.error(`Failed to fetch knowledgebases for Agent Alias ID ${agentAliasId}: ${error.message}`);
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
