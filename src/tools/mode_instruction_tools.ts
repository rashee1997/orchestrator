import { MemoryManager } from '../database/memory_manager.js';
import { InternalToolDefinition } from './index.js'; 
import { formatSimpleMessage, formatJsonToMarkdownCodeBlock } from '../utils/formatters.js';
import { McpError, ErrorCode } from '@modelcontextprotocol/sdk/types.js';

export const modeInstructionToolDefinitions: InternalToolDefinition[] = [
  {
    name: 'add_mode',
    description: 'Stores a mode-specific instruction for an AI agent. Output is Markdown formatted.',
    inputSchema: {
      type: 'object',
      properties: {
        agent_id: { type: 'string', description: 'Identifier of the AI agent.' },
        mode_name: { type: 'string', description: 'The name of the operational mode (e.g., "THINK_MODE", "PLAN_MODE").' },
        instruction_content: { type: 'string', description: 'The detailed instruction content for the specified mode.' },
        instruction_version: { type: 'number', description: 'Optional: Version of the instruction. If not provided, defaults to 1 and increments for updates.' }
      },
      required: ['agent_id', 'mode_name', 'instruction_content'],
      additionalProperties: false
    },
    func: async (args: any, memoryManagerInstance?: MemoryManager) => {
      if (!memoryManagerInstance) throw new McpError(ErrorCode.InternalError, "MemoryManager instance is required.");
      const agent_id_to_use = args.agent_id;
      if (!agent_id_to_use) throw new McpError(ErrorCode.InvalidParams, "agent_id is required for add_mode");
      
      const instruction_id = await memoryManagerInstance.modeInstructionManager.storeModeInstruction(
        agent_id_to_use,
        args.mode_name,
        args.instruction_content,
        args.instruction_version
      );
      return { content: [{ type: 'text', text: formatSimpleMessage(`Mode instruction for \`${args.mode_name}\` (version ${args.instruction_version || 'latest'}) added with ID: \`${instruction_id}\``, "Mode Instruction Added") }] };
    }
  },
  {
    name: 'get_mode',
    description: 'Retrieves a mode-specific instruction for an AI agent. Output is Markdown formatted.',
    inputSchema: {
      type: 'object',
      properties: {
        agent_id: { type: 'string', description: 'Identifier of the AI agent.' },
        mode_name: { type: 'string', description: 'The name of the operational mode.' },
        instruction_version: { type: 'number', description: 'Optional: Specific version of the instruction to retrieve. If not provided, the latest active version is returned.' }
      },
      required: ['agent_id', 'mode_name'],
      additionalProperties: false
    },
    func: async (args: any, memoryManagerInstance?: MemoryManager) => {
      if (!memoryManagerInstance) throw new McpError(ErrorCode.InternalError, "MemoryManager instance is required.");
      const agent_id_to_use = args.agent_id;
      if (!agent_id_to_use) throw new McpError(ErrorCode.InvalidParams, "agent_id is required for get_mode");

      const instruction = await memoryManagerInstance.modeInstructionManager.getModeInstruction(
        agent_id_to_use,
        args.mode_name,
        args.instruction_version
      );
      if (instruction) {
        let md = `## Mode Instruction: \`${instruction.mode_name}\` for Agent: \`${agent_id_to_use}\`\n`;
        md += `- **Version:** ${instruction.version || 'Latest'}\n`;
        md += `- **Instruction ID:** \`${instruction.instruction_id}\`\n`;
        md += `- **Created:** ${new Date(instruction.creation_timestamp * 1000).toLocaleString()}\n`;
        md += `- **Last Updated:** ${new Date(instruction.last_updated_timestamp * 1000).toLocaleString()}\n`;
        md += `### Content:\n${formatJsonToMarkdownCodeBlock(instruction.instruction_content, 'text')}\n`;
        return { content: [{ type: 'text', text: md }] };
      } else {
        return { content: [{ type: 'text', text: formatSimpleMessage(`No mode instruction found for mode \`${args.mode_name}\` (version ${args.instruction_version || 'latest'}).`, "Mode Instruction Not Found") }] };
      }
    }
  },
  {
    name: 'delete_mode',
    description: 'Deletes a mode-specific instruction for an AI agent. Output is Markdown formatted.',
    inputSchema: {
      type: 'object',
      properties: {
        agent_id: { type: 'string', description: 'Identifier of the AI agent.' },
        mode_name: { type: 'string', description: 'The name of the operational mode.' },
        instruction_version: { type: 'number', description: 'Optional: Specific version of the instruction to delete. If not provided, all versions for the mode will be deleted.' }
      },
      required: ['agent_id', 'mode_name'],
      additionalProperties: false
    },
    func: async (args: any, memoryManagerInstance?: MemoryManager) => {
      if (!memoryManagerInstance) throw new McpError(ErrorCode.InternalError, "MemoryManager instance is required.");
      const agent_id_to_use = args.agent_id;
      if (!agent_id_to_use) throw new McpError(ErrorCode.InvalidParams, "agent_id is required for delete_mode");

      const changes = await memoryManagerInstance.modeInstructionManager.deleteModeInstruction(
        agent_id_to_use,
        args.mode_name,
        args.instruction_version
      );
      return { content: [{ type: 'text', text: formatSimpleMessage(`Deleted ${changes} mode instruction(s) for mode \`${args.mode_name}\` (version ${args.instruction_version || 'all'}).`, "Mode Instruction Deleted") }] };
    }
  },
  {
    name: 'update_mode',
    description: 'Updates an existing mode-specific instruction for an AI agent by mode name. If the mode/version doesn\'t exist, it will be created. Output is Markdown formatted.',
    inputSchema: {
      type: 'object',
      properties: {
        agent_id: { type: 'string', description: 'Identifier of the AI agent.' },
        mode_name: { type: 'string', description: 'The name of the operational mode.' },
        instruction_content: { type: 'string', description: 'The new instruction content for the specified mode.' },
        instruction_version: { type: 'number', description: 'Optional: Version of the instruction. If not provided, defaults to 1 and increments for updates.' }
      },
      required: ['agent_id', 'mode_name', 'instruction_content'],
      additionalProperties: false
    },
    func: async (args: any, memoryManagerInstance?: MemoryManager) => {
        if (!memoryManagerInstance) throw new McpError(ErrorCode.InternalError, "MemoryManager instance is required.");
        const agent_id_to_use = args.agent_id;
        if (!agent_id_to_use) throw new McpError(ErrorCode.InvalidParams, "agent_id is required for update_mode");
        
        const instruction_id = await memoryManagerInstance.modeInstructionManager.storeModeInstruction(
          agent_id_to_use,
          args.mode_name,
          args.instruction_content,
          args.instruction_version 
        );
        return { content: [{ type: 'text', text: formatSimpleMessage(`Mode instruction for \`${args.mode_name}\` (version ${args.instruction_version || 'latest'}) updated/added with ID: \`${instruction_id}\``, "Mode Instruction Updated") }] };
    }
  }
];

export function getModeInstructionToolHandlers(memoryManager: MemoryManager) {
  const handlers: { [key: string]: Function } = {};
  modeInstructionToolDefinitions.forEach(def => {
    if (def.func) {
      handlers[def.name] = (args: any, agent_id_from_server?: string) => def.func!(args, memoryManager);
    }
  });
  return handlers;
}
