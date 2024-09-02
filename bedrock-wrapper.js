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

            // Extract the top-level routing configuration
            const routingConfigurations = response.agentAlias.routingConfiguration || [];
            const latestRoutingConfiguration = routingConfigurations[0] || {};  // Use the first element, which is the top-level configuration
            const agentVersion = latestRoutingConfiguration.agentVersion;

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
                return enabledKnowledgebases;
            } else {
                core.info(`No enabled knowledgebases associated with Agent Alias ID ${agentAliasId}`);
                return [];
            }
        } catch (error) {
            core.error(`Failed to fetch knowledgebases for Agent Alias ID ${agentAliasId}: ${error.message}`);
            throw new Error(`Failed to get knowledgebases for agent: ${error.message}`);
        }
    }

    async invokeAgent(agentId, agentAliasId, sessionId, prompt, memoryId = null) {
        try {
            // Fetch knowledgebases associated with the agent
            const knowledgebases = await this.getKnowledgebases(agentId, agentAliasId);
    
            // Prepare knowledgeBaseConfigurations if there are enabled knowledgebases
            const knowledgeBaseConfigurations = knowledgebases.map(kbId => ({
                knowledgeBaseId: kbId,
                retrievalConfiguration: {
                    vectorSearchConfiguration: {
                        numberOfResults: 5, // Adjust this as needed
                        overrideSearchType: "SEMANTIC", // Adjust if needed
                    }
                }
            }));
    
            // Construct command parameters
            const commandParams = {
                agentId,
                agentAliasId,
                sessionId,
                inputText: prompt,
                ...(memoryId ? { memoryId } : {}),
                ...(knowledgeBaseConfigurations.length > 0 ? {
                    sessionState: { knowledgeBaseConfigurations }
                } : {})
            };
    
            // Log command parameters in chunks
            const logChunkSize = 2000; // Size of each log chunk
            const commandParamsString = JSON.stringify(commandParams);
            for (let i = 0; i < commandParamsString.length; i += logChunkSize) {
                core.info(`Agent invocation params chunk: ${commandParamsString.substring(i, i + logChunkSize)}`);
            }
    
            // Create and send the command
            const command = new InvokeAgentCommand(commandParams);
            const response = await this.runtimeClient.send(command);
    
            core.info(`Agent invocation response received: ${JSON.stringify(response)}`);
    
            if (!response.completion) {
                throw new Error("Completion is undefined in the response.");
            }
    
            // Process completion
            let completion = "";
            for await (let chunkEvent of response.completion) {
                const chunk = chunkEvent.chunk;
                completion += new TextDecoder("utf-8").decode(chunk.bytes);
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
