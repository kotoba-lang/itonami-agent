import readline from 'node:readline';

const input = readline.createInterface({input: process.stdin});
for await (const line of input) {
  let request;
  try { request = JSON.parse(line); } catch { continue; }
  if (!Object.hasOwn(request, 'id')) continue;
  let result = {};
  if (request.method === 'initialize') {
    result = {
      protocolVersion: request.params.protocolVersion,
      capabilities: {tools: {}},
      serverInfo: {name: 'itonami-test-fixture', version: '1'},
    };
  } else if (request.method === 'tools/list') {
    result = {tools: [{
      name: 'echo',
      description: 'Return the supplied arguments as text',
      inputSchema: {type: 'object', properties: {text: {type: 'string'}}, required: ['text']},
    }]};
  } else if (request.method === 'tools/call') {
    result = {content: [{type: 'text', text: JSON.stringify(request.params.arguments)}], isError: false};
  }
  process.stdout.write(JSON.stringify({jsonrpc: '2.0', id: request.id, result}) + '\n');
}
