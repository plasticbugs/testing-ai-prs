// ai-implement.js
const axios = require('axios');
const { spawn } = require('child_process');
const fs = require('fs');
const { promisify } = require('util');
const exec = promisify(require('child_process').exec);
const readline = require('readline');

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

// Validate required environment variables
if (!PR_BODY || !REPO_OWNER || !REPO_NAME || !PR_NUMBER || !BRANCH_NAME || !AI_API_KEY || !GITHUB_TOKEN) {
  console.error('Missing required environment variables');
  process.exit(1);
}

// Function to call the AI API
async function callAnthropicAPI(prompt) {
  try {
    console.log('Calling Anthropic API with prompt...');
    
    const response = await axios.post(
      'https://api.anthropic.com/v1/messages',
      {
        model: "claude-3-7-sonnet-20250219",
        max_tokens: 4000,
        messages: [{ role: "user", content: prompt }]
      },
      {
        headers: {
          'Content-Type': 'application/json',
          'x-api-key': AI_API_KEY,
          'anthropic-version': '2023-06-01'
        }
      }
    );
    
    console.log('Received response from Anthropic API');
    return response.data;
  } catch (error) {
    console.error('Error calling Anthropic API:', error.response?.data || error.message);
    throw error;
  }
}

// Function to interact with the MCP server
async function callMcpMethod(mcpProcess, toolName, arguments) {
  return new Promise((resolve, reject) => {
    const requestId = Math.floor(Math.random() * 10000);
    
    const request = {
      jsonrpc: "2.0",
      id: requestId,
      method: "mcp.call_tool",  // Change to match the exact method name
      params: {
        name: toolName,
        arguments: arguments
      }
    };
    
    console.log(`Calling MCP tool ${toolName}:`, JSON.stringify(arguments, null, 2));
    mcpProcess.stdin.write(JSON.stringify(request) + '\n');
    
    // Set up readline interface to read from MCP process stdout
    const rl = readline.createInterface({
      input: mcpProcess.stdout,
      terminal: false
    });
    
    // Handler for MCP responses
    const onLine = (line) => {
      try {
        const response = JSON.parse(line);
        console.log('MCP response:', JSON.stringify(response, null, 2));
        
        if (response.id === requestId) {
          rl.close();
          if (response.error) {
            reject(new Error(`MCP error: ${JSON.stringify(response.error)}`));
          } else {
            // Parse the text content from the response
            const resultText = response.result?.content?.[0]?.text;
            try {
              // Try to parse the JSON result
              const parsedResult = resultText ? JSON.parse(resultText) : response.result;
              resolve(parsedResult);
            } catch (err) {
              // If not valid JSON, return the text directly
              resolve(resultText || response.result);
            }
          }
        }
      } catch (err) {
        console.error('Error parsing MCP response:', err, line);
      }
    };
    
    rl.on('line', onLine);
    
    // Set a timeout for the response
    const timeout = setTimeout(() => {
      rl.close();
      reject(new Error(`Timeout waiting for response to tool ${toolName}`));
    }, 30000);
    
    // Clean up on response
    rl.once('close', () => {
      clearTimeout(timeout);
    });
  });
}

async function implementWithPrompt() {
  let mcpProcess = null;
  
  try {
    // Start the MCP server
    console.log('Starting MCP server...');
    mcpProcess = spawn('npx', ['-y', '@modelcontextprotocol/server-github'], {
      stdio: ['pipe', 'pipe', 'pipe'],
      env: {
        ...process.env,
        GITHUB_PERSONAL_ACCESS_TOKEN: GITHUB_TOKEN
      }
    });
    
    mcpProcess.stderr.on('data', (data) => {
      console.error(`MCP stderr: ${data.toString()}`);
    });
    
    // Wait for MCP server to start
    await new Promise(resolve => setTimeout(resolve, 2000));
    
    // First, list available tools
    const toolsRequest = {
      jsonrpc: "2.0",
      id: Math.floor(Math.random() * 10000),
      method: "list_tools",
      params: {}
    };
    
    console.log('Listing available tools from MCP server');
    mcpProcess.stdin.write(JSON.stringify(toolsRequest) + '\n');
    
    // Wait a bit to see tools in logs
    await new Promise(resolve => setTimeout(resolve, 1000));
    
    // Continue with the main implementation
    const prompt = `
You are an AI tasked with creating a README.md file for a GitHub repository based on a Pull Request description.

Repository: ${REPO_OWNER}/${REPO_NAME}
Branch: ${BRANCH_NAME}
PR Number: ${PR_NUMBER}

PR Description:
${PR_BODY}

Based on this PR description, create a README.md file for this repository. 
Your README should be comprehensive, well-formatted with Markdown, and include all the necessary sections 
(description, features, installation instructions, etc.).

If the PR description mentions specific technologies, themes, or features, be sure to incorporate those.
For example, if it mentions a cat theme, include cat emojis and playful cat-related language.

Respond with ONLY the content that should go in the README.md file, nothing else.
`;

    // Call the AI API to generate README content
    const aiResponse = await callAnthropicAPI(prompt);
    
    // Extract the README content from the AI response
    const readmeContent = aiResponse.content[0].text.trim();
    console.log('Generated README content:', readmeContent);
    
    // Check if README.md exists
    let readmeExists = false;
    let existingSha = null;
    try {
      const result = await callMcpMethod(mcpProcess, "get_file_contents", {
        owner: REPO_OWNER,
        repo: REPO_NAME,
        path: "README.md",
        branch: BRANCH_NAME
      });
      
      if (result && result.sha) {
        readmeExists = true;
        existingSha = result.sha;
        console.log('Existing README.md found with SHA:', existingSha);
      }
    } catch (error) {
      console.log('README.md does not exist yet, will create it');
    }
    
    // Create or update the README.md file
    const commitMessage = `${readmeExists ? 'Update' : 'Create'} README.md based on PR #${PR_NUMBER}`;
    
    const updateResult = await callMcpMethod(mcpProcess, "create_or_update_file", {
      owner: REPO_OWNER,
      repo: REPO_NAME,
      path: "README.md",
      message: commitMessage,
      content: Buffer.from(readmeContent).toString('base64'),
      branch: BRANCH_NAME,
      ...(readmeExists ? { sha: existingSha } : {})
    });
    
    console.log('File creation/update result:', updateResult);
    
    // Add a comment to the PR
    await callMcpMethod(mcpProcess, "add_issue_comment", {
      owner: REPO_OWNER,
      repo: REPO_NAME,
      issue_number: parseInt(PR_NUMBER),
      body: `✅ I've ${readmeExists ? 'updated' : 'created'} the README.md based on the PR description. Please review the changes!`
    });
    
    // Mark the PR as ready for review using GitHub CLI
    await exec(`gh pr ready ${PR_NUMBER}`, {
      env: {
        ...process.env,
        GITHUB_TOKEN: GITHUB_TOKEN
      }
    });
    
    return {
      status: 'success',
      message: `${readmeExists ? 'Updated' : 'Created'} README.md successfully`,
      fileChanges: [{
        name: 'create_or_update_file',
        path: 'README.md'
      }]
    };
  } catch (error) {
    console.error('Error in implementation:', error);
    throw error;
  } finally {
    if (mcpProcess) {
      mcpProcess.kill();
    }
  }
}

async function debugMcpServer() {
  let mcpProcess = null;
  
  try {
    console.log('Starting MCP server for debugging...');
    mcpProcess = spawn('npx', ['-y', '@modelcontextprotocol/server-github'], {
      stdio: ['pipe', 'pipe', 'pipe'],
      env: {
        ...process.env,
        GITHUB_PERSONAL_ACCESS_TOKEN: GITHUB_TOKEN,
        DEBUG: 'mcp:*'
      }
    });
    
    mcpProcess.stdout.on('data', (data) => {
      console.log(`MCP stdout: ${data.toString()}`);
    });
  } catch (error) {
    console.error('Error starting MCP server for debugging:', error);
    throw error;
  }
}

async function main() {
  try {
    console.log('Starting AI PR implementation...');
    console.log(`Repository: ${REPO_OWNER}/${REPO_NAME}`);
    console.log(`PR: #${PR_NUMBER}, Branch: ${BRANCH_NAME}`);
    
    // Implement with prompt-based approach
    const result = await implementWithPrompt();
    
    // Set output for the GitHub Action
    const outputPath = process.env.GITHUB_OUTPUT;
    if (outputPath) {
      fs.appendFileSync(outputPath, `status=${result.status}\n`);
      fs.appendFileSync(outputPath, `message=${result.message}\n`);
    }
    
    console.log('PR implementation completed with status:', result.status);
    
    if (result.status === 'success') {
      process.exit(0);
    } else {
      process.exit(1);
    }
  } catch (error) {
    console.error('Error in main process:', error);
    process.exit(1);
  }
}

main();