# Custom Amazon Bedrock Agent

![GitHub Action](https://img.shields.io/badge/Custom%20Bedrock%20Analysis-blue)

This GitHub Action analyzes files in a pull request (PR) using an Amazon Bedrock Agent, providing detailed insights, potential improvements, and security considerations based on the code changes.

## Features

- **Amazon Bedrock Agent Integration**: Analyze PR files using a Bedrock Agent.
- **Customizable Prompts**: Define specific analysis prompts.
- **Language-Specific Analysis**: Provide tailored analysis for different programming languages.
- **File Ignoring**: Ignore files or patterns, similar to `.gitignore`.
- **Session Memory**: Optionally maintain session state with a `memory_id`.

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
