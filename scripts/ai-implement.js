// ai-implement.js
const axios = require('axios');
const { spawn } = require('child_process');
const fs = require('fs');
const { promisify } = require('util');
const exec = promisify(require('child_process').exec);

// Get environment variables
const {
  PR_BODY,
  REPO_OWNER,
  REPO_NAME,
  PR_NUMBER,
  BRANCH_NAME,
  AI_API_KEY,
  GITHUB_TOKEN
} = process.env;

if (!PR_BODY || !REPO_OWNER || !REPO_NAME || !PR_NUMBER || !BRANCH_NAME || !AI_API_KEY || !GITHUB_TOKEN) {
  console.error('Missing required environment variables');
  console.error({
    PR_BODY: !!PR_BODY,
    REPO_OWNER: !!REPO_OWNER,
    REPO_NAME: !!REPO_NAME,
    PR_NUMBER: !!PR_NUMBER,
    BRANCH_NAME: !!BRANCH_NAME,
    AI_API_KEY: !!AI_API_KEY,
    GITHUB_TOKEN: !!GITHUB_TOKEN
  });
  process.exit(1);
}

// Function to call the AI API
const callAI = async (prompt, mcpProcessStdin, mcpProcessStdout) => {
  try {
    console.log('Calling Anthropic API...');
    
    const response = await axios.post(
      'https://api.anthropic.com/v1/messages',
      {
        model: "claude-3-7-sonnet-20250219",
        max_tokens: 4000,
        messages: [{ role: "user", content: prompt }],
        tools: [
          {
            name: "mcp",
            description: "Model Context Protocol tool for GitHub operations"
          }
        ]
      },
      {
        headers: {
          'Content-Type': 'application/json',
          'x-api-key': AI_API_KEY,
          'anthropic-beta': '2023-06-01'
        }
      }
    );
    
    console.log('Received response from API');
    return response.data;
  } catch (error) {
    console.error('Error calling AI:', error.response?.data || error.message);
    throw error;
  }
};

// Function to run the MCP server and communicate with it
async function runWithMCP(prompt) {
  return new Promise((resolve, reject) => {
    console.log('Starting MCP server...');
    
    // Start the MCP server
    const mcpProcess = spawn('npx', ['-y', '@modelcontextprotocol/server-github'], {
      stdio: ['pipe', 'pipe', 'pipe'],
      env: {
        ...process.env,
        GITHUB_PERSONAL_ACCESS_TOKEN: GITHUB_TOKEN
      }
    });
    
    let mcpOutput = '';
    let mcpError = '';
    
    mcpProcess.stdout.on('data', (data) => {
      mcpOutput += data.toString();
      console.log(`MCP stdout: ${data}`);
    });
    
    mcpProcess.stderr.on('data', (data) => {
      mcpError += data.toString();
      console.error(`MCP stderr: ${data}`);
    });
    
    mcpProcess.on('error', (error) => {
      console.error('Failed to start MCP process:', error);
      reject(error);
    });
    
    // Give the MCP server a moment to start up
    setTimeout(async () => {
      try {
        // Prepare the prompt with context about the repository and PR
        const fullPrompt = `
You are tasked with implementing the changes described in this PR description:

${PR_BODY}

Repository: ${REPO_OWNER}/${REPO_NAME}
Branch: ${BRANCH_NAME}
PR Number: ${PR_NUMBER}

Use the GitHub MCP tools to:
1. Understand the repository structure
2. Make necessary code changes
3. Commit those changes to the branch

Tools available through MCP:
- get_file_contents: To examine existing files
- create_or_update_file: To modify individual files
- push_files: To commit multiple files at once
- list_pull_requests, get_pull_request: To get information about the PR
- get_pull_request_files: To see what files have been changed already

Implement the requested changes by making commits to the branch. Make sure all changes are properly tested.
`;

        // Call the AI API and pass the MCP stdin/stdout
        const aiResponse = await callAI(fullPrompt, mcpProcess.stdin, mcpProcess.stdout);
        console.log('AI Response:', JSON.stringify(aiResponse, null, 2));
        
        // Add a comment to the PR with a summary of changes
        try {
          await exec(`gh pr comment ${PR_NUMBER} --body "✅ AI implementation completed. Please review the changes."`, {
            env: {
              ...process.env,
              GITHUB_TOKEN: GITHUB_TOKEN
            }
          });
          console.log('Added comment to PR');
        } catch (error) {
          console.error('Error adding comment to PR:', error);
        }
        
        // Terminate the MCP process
        mcpProcess.kill();
        
        resolve({ status: 'success', message: 'Implementation completed successfully' });
      } catch (error) {
        console.error('Error in AI implementation:', error);
        mcpProcess.kill();
        reject(error);
      }
    }, 2000);
  });
}

async function main() {
  try {
    console.log('Starting AI PR implementation...');
    console.log(`Repository: ${REPO_OWNER}/${REPO_NAME}`);
    console.log(`PR: #${PR_NUMBER}, Branch: ${BRANCH_NAME}`);
    
    // Call the AI service through MCP
    const result = await runWithMCP(PR_BODY);
    
    // Set output for the GitHub Action (using newer syntax)
    const outputPath = process.env.GITHUB_OUTPUT;
    if (outputPath) {
      fs.appendFileSync(outputPath, `status=${result.status}\n`);
      fs.appendFileSync(outputPath, `message=${result.message}\n`);
    } else {
      // Fallback for older GitHub Actions
      console.log(`::set-output name=status::${result.status}`);
      console.log(`::set-output name=message::${result.message}`);
    }
    
    console.log('PR implementation completed with status:', result.status);
    
    if (result.status === 'success') {
      process.exit(0);
    } else {
      process.exit(1);
    }
  } catch (error) {
    console.error('Error in main process:', error);
    
    // Try to add a comment to the PR about the failure
    try {
      const errorMessage = error.message || 'Unknown error';
      await exec(`gh pr comment ${PR_NUMBER} --body "❌ AI implementation failed: ${errorMessage}"`, {
        env: {
          ...process.env,
          GITHUB_TOKEN: GITHUB_TOKEN
        }
      });
    } catch (commentError) {
      console.error('Failed to add error comment to PR:', commentError);
    }
    
    process.exit(1);
  }
}

main();