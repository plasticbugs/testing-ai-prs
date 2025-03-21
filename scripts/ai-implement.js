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

// Validate required environment variables
if (!PR_BODY || !REPO_OWNER || !REPO_NAME || !PR_NUMBER || !BRANCH_NAME || !AI_API_KEY || !GITHUB_TOKEN) {
  console.error('Missing required environment variables');
  process.exit(1);
}

// Function to process MCP tool use
async function processMcpToolUse(toolUse, mcpProcess) {
  return new Promise((resolve, reject) => {
    console.log(`Processing MCP tool use: ${JSON.stringify(toolUse)}`);
    
    // Send the tool input to the MCP server
    const inputJson = JSON.stringify(toolUse.input) + '\n';
    mcpProcess.stdin.write(inputJson);
    
    // Set up a collector for the output
    let outputData = '';
    let dataHandler = (data) => {
      const dataStr = data.toString();
      outputData += dataStr;
      
      // Check if we got a complete JSON response
      try {
        JSON.parse(outputData);
        // If we got here, we have a complete JSON response
        mcpProcess.stdout.removeListener('data', dataHandler);
        resolve(outputData);
      } catch (e) {
        // Not complete JSON yet, keep collecting
      }
    };
    
    mcpProcess.stdout.on('data', dataHandler);
    
    // Handle errors
    mcpProcess.stderr.once('data', (data) => {
      console.error(`MCP error for tool use: ${data}`);
      reject(new Error(`MCP error: ${data}`));
    });
  });
}

// Function to call the AI API and handle tool use
async function runWithAI(initialPrompt) {
  return new Promise(async (resolve, reject) => {
    console.log('Starting MCP server...');
    
    // Start the MCP server
    const mcpProcess = spawn('npx', ['-y', '@modelcontextprotocol/server-github'], {
      stdio: ['pipe', 'pipe', 'pipe'],
      env: {
        ...process.env,
        GITHUB_PERSONAL_ACCESS_TOKEN: GITHUB_TOKEN
      }
    });
    
    mcpProcess.stderr.on('data', (data) => {
      console.error(`MCP stderr: ${data}`);
    });
    
    // Wait for MCP server to start
    await new Promise(resolve => setTimeout(resolve, 2000));
    
    try {
      // Initial prompt to Claude
      let messages = [{ role: "user", content: initialPrompt }];
      let allFileChanges = [];
      
      // Continue conversation with Claude until it's done
      while (true) {
        console.log('Calling Anthropic API...');
        
        // Call Claude API
        const response = await axios.post(
          'https://api.anthropic.com/v1/messages',
          {
            model: "claude-3-7-sonnet-20250219",
            max_tokens: 4000,
            messages: messages,
            tools: [
              {
                type: "function",
                function: {
                  name: "mcp",
                  description: "Model Context Protocol tool for GitHub operations",
                  parameters: {
                    type: "object",
                    properties: {},
                    required: []
                  }
                }
              }
            ]
          },
          {
            headers: {
              'Content-Type': 'application/json',
              'x-api-key': AI_API_KEY,
              'anthropic-version': '2023-06-01'
            }
          }
        );
        
        console.log('Received response from API');
        
        const aiResponse = response.data;
        console.log(`AI Response: ${JSON.stringify(aiResponse, null, 2)}`);
        
        // Check if Claude wants to use a tool
        if (aiResponse.stop_reason === "tool_use") {
          // Find the tool use request
          const toolUse = aiResponse.content.find(item => item.type === "tool_use");
          
          if (toolUse && toolUse.name === "mcp") {
            // Process the tool use with MCP
            const toolResponse = await processMcpToolUse(toolUse, mcpProcess);
            
            // Add the tool response to the conversation
            messages.push({
              role: "assistant",
              content: [
                ...aiResponse.content
              ]
            });
            
            messages.push({
              role: "user",
              content: [
                {
                  type: "tool_result",
                  tool_use_id: toolUse.id,
                  content: toolResponse
                }
              ]
            });
            
            // Track file changes
            try {
              const parsedResponse = JSON.parse(toolResponse);
              if (parsedResponse.name === "create_or_update_file" || 
                  parsedResponse.name === "push_files") {
                allFileChanges.push(parsedResponse);
              }
            } catch (e) {
              console.error('Error parsing tool response:', e);
            }
          } else {
            console.error('Unknown tool use request:', toolUse);
            break;
          }
        } else {
          // Claude is done, add final response and exit loop
          messages.push({
            role: "assistant",
            content: aiResponse.content
          });
          break;
        }
      }
      
      // Terminate the MCP process
      mcpProcess.kill();
      
      resolve({ 
        status: 'success', 
        message: 'Implementation completed successfully',
        fileChanges: allFileChanges
      });
    } catch (error) {
      console.error('Error in AI communication:', error);
      mcpProcess.kill();
      reject(error);
    }
  });
}

async function main() {
  try {
    console.log('Starting AI PR implementation...');
    console.log(`Repository: ${REPO_OWNER}/${REPO_NAME}`);
    console.log(`PR: #${PR_NUMBER}, Branch: ${BRANCH_NAME}`);
    
    // Prepare the prompt with context about the repository and PR
    const fullPrompt = `
You are tasked with implementing the changes described in this PR description:

${PR_BODY}

Repository: ${REPO_OWNER}/${REPO_NAME}
Branch: ${BRANCH_NAME}
PR Number: ${PR_NUMBER}

Use the GitHub MCP tools to:
1. Understand the repository structure first by getting file contents
2. Make necessary code changes based on the PR description
3. Commit those changes to the branch

Available MCP tools include:
- get_file_contents: To examine existing files
- create_or_update_file: To modify individual files
- push_files: To commit multiple files at once
- list_pull_requests, get_pull_request: To get information about the PR
- get_pull_request_files: To see what files have been changed already

Please implement the requested changes by making commits to the branch. Be thorough and complete the implementation.
`;
    
    // Call the AI service through MCP
    const result = await runWithAI(fullPrompt);
    
    // Add a comment to the PR with a summary of changes
    let comment = "✅ AI implementation completed. The following changes were made:\n\n";
    
    if (result.fileChanges && result.fileChanges.length > 0) {
      result.fileChanges.forEach(change => {
        if (change.name === "create_or_update_file") {
          comment += `- Updated file: ${change.path}\n`;
        } else if (change.name === "push_files") {
          comment += `- Pushed multiple files in a single commit\n`;
          change.files.forEach(file => {
            comment += `  - ${file.path}\n`;
          });
        }
      });
    } else {
      comment += "No file changes were detected. Please check the implementation.";
    }
    
    await exec(`gh pr comment ${PR_NUMBER} --body "${comment}"`, {
      env: {
        ...process.env,
        GITHUB_TOKEN: GITHUB_TOKEN
      }
    });
    console.log('Added comment to PR');
    
    // Set output for the GitHub Action
    const outputPath = process.env.GITHUB_OUTPUT;
    if (outputPath) {
      fs.appendFileSync(outputPath, `status=${result.status}\n`);
      fs.appendFileSync(outputPath, `message=${result.message}\n`);
    }
    
    console.log('PR implementation completed with status:', result.status);
    
    if (result.status === 'success' && result.fileChanges && result.fileChanges.length > 0) {
      process.exit(0);
    } else {
      console.log('No file changes were made. Exiting with error code.');
      process.exit(1);
    }
  } catch (error) {
    console.error('Error in main process:', error);
    process.exit(1);
  }
}

main();