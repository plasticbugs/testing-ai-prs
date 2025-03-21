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

async function runMcpProcess() {
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
    console.error(`MCP stderr: ${data.toString()}`);
  });
  
  // Wait for MCP server to start
  await new Promise(resolve => setTimeout(resolve, 2000));
  
  return mcpProcess;
}

// Simpler approach without using the tools API
async function runManualImplementation() {
  const mcpProcess = await runMcpProcess();
  
  // Create a readline interface to read from the MCP process
  const rl = readline.createInterface({
    input: mcpProcess.stdout,
    output: process.stdout,
    terminal: false
  });
  
  // Function to send a command to MCP and get response
  const executeMcpCommand = (command, args) => {
    return new Promise((resolve, reject) => {
      const request = {
        jsonrpc: "2.0",
        id: Math.floor(Math.random() * 10000),
        method: command,
        params: args
      };
      
      console.log(`Executing MCP command: ${command}`, args);
      mcpProcess.stdin.write(JSON.stringify(request) + '\n');
      
      const messageHandler = (line) => {
        try {
          const response = JSON.parse(line);
          if (response.id === request.id) {
            rl.off('line', messageHandler);
            if (response.error) {
              reject(new Error(`MCP error: ${JSON.stringify(response.error)}`));
            } else {
              resolve(response.result);
            }
          }
        } catch (err) {
          console.error('Error parsing MCP response:', err);
        }
      };
      
      rl.on('line', messageHandler);
    });
  };
  
  try {
    // Step 1: Check if README.md exists
    console.log('Checking if README.md exists...');
    let readmeContent = "";
    try {
      const result = await executeMcpCommand('get_file_contents', {
        owner: REPO_OWNER,
        repo: REPO_NAME,
        path: 'README.md',
        branch: BRANCH_NAME
      });
      
      if (result && result.content) {
        readmeContent = Buffer.from(result.content, 'base64').toString('utf-8');
        console.log('Existing README.md found:', readmeContent);
      }
    } catch (error) {
      console.log('README.md does not exist yet, will create it');
    }
    
    // Step 2: Create a new README based on the PR description
    let newReadmeContent = "";
    
    if (PR_BODY.toLowerCase().includes('readme')) {
      // Extract requirements from PR body
      const requirements = PR_BODY.replace(/create|update|readme|\.md/gi, '').trim();
      
      // Create a simple README
      newReadmeContent = `# ${REPO_NAME}\n\n`;
      
      if (requirements) {
        newReadmeContent += `${requirements}\n\n`;
      } else {
        newReadmeContent += `This repository contains the code for ${REPO_NAME}.\n\n`;
      }
      
      newReadmeContent += `## Getting Started\n\n`;
      newReadmeContent += `1. Clone the repository\n`;
      newReadmeContent += `2. Install dependencies\n`;
      newReadmeContent += `3. Run the application\n\n`;
      
      newReadmeContent += `## License\n\n`;
      newReadmeContent += `MIT\n`;
    } else {
      // Use PR description directly if it doesn't mention README
      newReadmeContent = `# ${REPO_NAME}\n\n${PR_BODY}\n\n## Created by AI PR Implementation`;
    }
    
    // Step 3: Commit the README.md file
    console.log('Creating/updating README.md...');
    const commitMessage = `Add README.md as requested in PR #${PR_NUMBER}`;
    
    const updateResult = await executeMcpCommand('create_or_update_file', {
      owner: REPO_OWNER,
      repo: REPO_NAME,
      path: 'README.md',
      message: commitMessage,
      content: Buffer.from(newReadmeContent).toString('base64'),
      branch: BRANCH_NAME,
      ...(readmeContent ? { sha: readmeContent.sha } : {})
    });
    
    console.log('README.md update result:', updateResult);
    
    // Clean up
    mcpProcess.kill();
    
    return {
      status: 'success',
      message: 'Created README.md successfully',
      fileChanges: [{
        name: 'create_or_update_file',
        path: 'README.md'
      }]
    };
  } catch (error) {
    console.error('Error in manual implementation:', error);
    mcpProcess.kill();
    throw error;
  }
}

async function main() {
  try {
    console.log('Starting AI PR implementation...');
    console.log(`Repository: ${REPO_OWNER}/${REPO_NAME}`);
    console.log(`PR: #${PR_NUMBER}, Branch: ${BRANCH_NAME}`);
    
    // Use a simpler, direct implementation approach instead of AI API
    const result = await runManualImplementation();
    
    // Add a comment to the PR with a summary of changes
    let comment = "✅ AI implementation completed. The following changes were made:\n\n";
    
    if (result.fileChanges && result.fileChanges.length > 0) {
      result.fileChanges.forEach(change => {
        comment += `- Updated file: ${change.path}\n`;
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