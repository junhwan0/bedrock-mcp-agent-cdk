import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { StdioClientTransport } from "@modelcontextprotocol/sdk/client/stdio.js";

// Helper function to sanitize log data
const sanitizeLogData = (data) => {
  if (typeof data !== 'string') {
      data = String(data);
  }
  // Remove control characters and new lines
  return data.replace(/[\x00-\x1F\x7F-\x9F\n\r]/g, '')
             // Escape special characters
             .replace(/[&<>"']/g, (char) => {
                 const entities = {
                     '&': '&amp;',
                     '<': '&lt;',
                     '>': '&gt;',
                     '"': '&quot;',
                     "'": '&#x27;'
                 };
                 return entities[char];
             });
};

const safeLogger = {
  _log: (type, message, ...args) => {
      const sanitizedArgs = args.map(arg => 
          typeof arg === 'object' ? 
              JSON.stringify(arg).replace(/[\x00-\x1F\x7F-\x9F\n\r]/g, '') : 
              sanitizeLogData(arg)
      );
      console[type](sanitizeLogData(message), ...sanitizedArgs);
  },
  log: (message, ...args) => safeLogger._log('log', message, ...args),
  warn: (message, ...args) => safeLogger._log('warn', message, ...args),
  error: (message, ...args) => safeLogger._log('error', message, ...args),
  info: (message, ...args) => safeLogger._log('info', message, ...args)
};

class ResourcePool {
  constructor(maxSize, createClientFn) {
    this.pool = [];
    this.inUse = new Set();
    this.maxSize = maxSize;
    this.createClientFn = createClientFn;
  }

  async createNewClient() {
    const client = await this.createClientFn();
    return client;
  }

  async acquire() {
    try {
      if (this.pool.length > 0) {
        const client = this.pool.pop();
        this.inUse.add(client);
        return client;
      }

      if (this.inUse.size < this.maxSize) {
        const client = await this.createNewClient();
        this.inUse.add(client);
        return client;
      }

      return new Promise((resolve, reject) => {
        const checkPool = setInterval(async () => {
          try {
            if (this.pool.length > 0) {
              clearInterval(checkPool);
              const client = this.pool.pop();
              this.inUse.add(client);
              resolve(client);
            }
          } catch (error) {
            clearInterval(checkPool);
            reject(error);
          }
        }, 100);
      });
    } catch (error) {
      safeLogger.error('Error acquiring client:', error);
      throw error;
    }
  }

  release(client) {
    if (this.inUse.has(client)) {
      this.inUse.delete(client);
      this.pool.push(client);
    }
  }

  async handleError(client) {
    try {
      safeLogger.error('Error occurred with client:', client);
      this.inUse.delete(client);
      const newClient = await this.createNewClient();
      this.pool.push(newClient);
      return newClient;
    } catch (error) {
      safeLogger.error('Error creating new client:', error);
      throw error;
    }
  }
}

const pool = new ResourcePool(5, async () => {
  // process.env.npm_config_cache = '/mnt/efs/.npm';
  // process.env.HOME = '/mnt/efs/home/';
  process.env.npm_config_cache = '/tmp/.npm';
  process.env.HOME = '/tmp/home/';
  // const mcpServerName = process.env.MCP_SERVER_NAME;
  const mcpServerConfig = JSON.parse(Buffer.from(process.env.MCP_SERVER_CONFIG, 'base64').toString('utf-8'));
  const command = mcpServerConfig.command;
  const args = mcpServerConfig.args ?? [];
  let env = mcpServerConfig.env ?? {};
  env = { ...process.env, ...env };
  const transport = new StdioClientTransport({
    command: command,
    args: args,
    env: env
  });
  
  const client = new Client(
    {
      name: "bedrock-agent-client",
      version: "0.0.1"
    },
    {
      capabilities: {
        tools: {}
      }
    }
  );

  await client.connect(transport);
  return client;
});

function convertPropertiesToArgs(properties) {
  return properties.reduce((args, prop) => {
      let convertedValue;
      try {
          switch(prop.type) {
              case 'string':
                  convertedValue = String(prop.value);
                  break;
              case 'boolean':
                  if (typeof prop.value === 'boolean') {
                      convertedValue = prop.value;
                  } else if (typeof prop.value === 'string') {
                      convertedValue = prop.value.toLowerCase() === 'true';
                  } else {
                      convertedValue = Boolean(prop.value);
                  }
                  break;
              case 'integer':
                  const parsed = parseInt(prop.value, 10);
                  if (isNaN(parsed)) {
                      throw new Error(`Invalid integer value: ${prop.value}`);
                  }
                  convertedValue = parsed;
                  break;
              default:
                  convertedValue = prop.value;
          }
      } catch (error) {
          safeLogger.warn(`Error converting property ${prop.name}: ${error.message}`);
          convertedValue = prop.value; // fail to convert
      }
      
      args[prop.name] = convertedValue;
      return args;
  }, {});
}

export const handler = async (event, context) => {
  safeLogger.log('start');
  const httpMethod = event.httpMethod;
  const agent = event.agent;
  const actionGroup = event.actionGroup;
  const apiPath = event.apiPath;
  const parameters = event.parameters;
  const toolName = apiPath.replace(/^\//, '');
  const properties = event.requestBody.content["application/json"].properties

  safeLogger.log(JSON.stringify(event), null, 2)
  safeLogger.log(httpMethod);
  safeLogger.log(agent);
  safeLogger.log(actionGroup);
  safeLogger.log(apiPath);
  safeLogger.log(parameters);
  
  const toolArg = {
    name: toolName,
    arguments: convertPropertiesToArgs(properties)
  }
  safeLogger.log(JSON.stringify(toolArg));

  const client = await pool.acquire();
  try {
    const result = await client.callTool(toolArg);
    pool.release(client);
    const ret = {
      "messageVersion": "1.0",
      "response": {
        "actionGroup": actionGroup,
        "apiPath": apiPath,
        "httpMethod": httpMethod,
        "httpStatusCode": 200,
        "responseBody": {
          "application/json": {
            "body": JSON.stringify(result)
          }
        }
      }
    }
    safeLogger.log(JSON.stringify(ret));
    return ret;
  } catch (error) {
    const newCclient = await pool.handleError(client);
    pool.release(newCclient);
    throw error;
  }
};