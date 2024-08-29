# Custom Amazon Bedrock Agent

![GitHub Action](https://img.shields.io/badge/Custom%20Bedrock%20Analysis-blue)

This GitHub Action is a highly customizable tool that analyzes files in a pull request (PR) using an Amazon Bedrock Agent. You can tailor the analysis based on the specific knowledge base and prompt you choose for the agent, making it suitable for a wide range of use cases, from code quality checks to security assessments and more.

![sequence diagram](docs/sequence_diagram.png)

## Features

- **Customizable Agent Analysis**: Leverage Amazon Bedrock Agent's knowledge base and custom prompts to analyze PR files according to your specific requirements.
- **Flexible Use Cases**: Adapt the action for various use cases such as code quality improvement, security assessments, performance optimizations, and more.
- **Language-Specific Analysis**: Provide tailored analysis for different programming languages by configuring language-specific prompts.
- **File Ignoring**: Define patterns to ignore certain files or directories, similar to `.gitignore`.
- **Session Memory**: Optionally maintain session state with a `memory_id`, allowing for context-aware analysis across PRs.

## Prerequisites

Before using this GitHub Action, you need to complete the following steps:

1. **Create an Amazon Bedrock Agent**: Set up an Amazon Bedrock Agent in your AWS account. This involves configuring the agent with a system prompt that defines the foundational behavior and knowledge base the agent will use during analysis.
   
2. *(Optional)* **Create an Amazon Bedrock Knowledgebase**: For more advanced use cases, you can create an Amazon Bedrock Knowledgebase and associate it with your Bedrock Agent. This allows the agent to leverage a specific set of documents or data during its analysis.

   > **Disclaimer:** Using a Knowledgebase can significantly increase your cloud spend. Be sure to monitor usage and costs carefully to avoid unexpected charges.

3. **Configure AWS Credentials**: Ensure you have the necessary AWS credentials (`AWS_ACCESS_KEY_ID`, `AWS_SECRET_ACCESS_KEY`, and `AWS_REGION`) configured as GitHub Secrets in your repository. These credentials will allow the GitHub Action to communicate with the Amazon Bedrock Agent.

## Inputs

| Name                      | Description                                                                     | Required | Default                                                                                       |
|---------------------------|---------------------------------------------------------------------------------|----------|-----------------------------------------------------------------------------------------------|
| `ignore_patterns`         | Comma-separated list of glob patterns to ignore (similar to `.gitignore`).      | true     | `**/*.md,docs/**`                                                                             |
| `action_prompt`           | The prompt to send to the Bedrock Agent for analysis.                           | true     | `Given the relevant code changes above, provide a detailed analysis including potential improvements and security considerations.` |
| `agent_id`                | The ID of the Bedrock Agent to use.                                             | true     | N/A                                                                                           |
| `agent_alias_id`          | The alias ID of the Bedrock Agent to use.                                       | true     | N/A                                                                                           |
| `memory_id`               | The optional memory ID to maintain session state with the Bedrock Agent.        | false    | N/A                                                                                           |
| `language_specific_prompts`| JSON string of language-specific prompts.                                      | false    | `{"js":"For JavaScript, consider performance and ES6+ features.","py":"For Python, check PEP 8 compliance and use of type hints."}` |

## Environment Variables

This action requires the following environment variables:

| Name           | Description                                                       |
|----------------|-------------------------------------------------------------------|
| `GITHUB_TOKEN` | GitHub token for authenticating API requests (automatically set). |
| `AWS_ACCESS_KEY_ID` | AWS access key ID for Bedrock API authentication.            |
| `AWS_SECRET_ACCESS_KEY` | AWS secret access key for Bedrock API authentication.    |
| `AWS_REGION`   | AWS region where the Bedrock agent is deployed.                   |

## Example Usage

```yaml
name: Bedrock Analysis

on: [pull_request]

jobs:
  analyze:
    runs-on: ubuntu-latest
    steps:
      - name: Checkout code
        uses: actions/checkout@v2

      - name: Run Bedrock Analysis
        uses: your-repo/custom-bedrock-analysis@v1
        with:
          ignore_patterns: '**/*.md,docs/**'
          action_prompt: 'Analyze the code changes for potential performance improvements.'
          agent_id: 'your-agent-id'
          agent_alias_id: 'your-agent-alias-id'
          memory_id: 'optional-memory-id'  # Optional
          language_specific_prompts: '{"js":"Focus on ES6+ features and performance.","py":"Check for PEP 8 compliance and type hints."}'
        env:
          AWS_ACCESS_KEY_ID: ${{ secrets.AWS_ACCESS_KEY_ID }}
          AWS_SECRET_ACCESS_KEY: ${{ secrets.AWS_SECRET_ACCESS_KEY }}
          AWS_REGION: 'us-east-1'  # Replace with your AWS region
