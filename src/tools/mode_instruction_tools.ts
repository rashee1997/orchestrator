import { MemoryManager } from '../database/memory_manager.js';
import { Tool } from './index.js';

export const modeInstructionToolDefinitions: Tool[] = [
  {
    name: 'add_mode',
    description: 'Stores a mode-specific instruction for an AI agent.',
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
    func: async (args: any) => {
      // This func will be replaced by the actual handler in getModeInstructionToolHandlers
      throw new Error('Handler not implemented for definition');
    }
  },
  {
    name: 'get_mode',
    description: 'Retrieves a mode-specific instruction for an AI agent.',
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
    func: async (args: any) => {
      // This func will be replaced by the actual handler in getModeInstructionToolHandlers
      throw new Error('Handler not implemented for definition');
    }
  },
  {
    name: 'delete_mode',
    description: 'Deletes a mode-specific instruction for an AI agent.',
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
    func: async (args: any) => {
      // This func will be replaced by the actual handler in getModeInstructionToolHandlers
      throw new Error('Handler not implemented for definition');
    }
  },
  {
    name: 'update_mode',
    description: 'Updates an existing mode-specific instruction for an AI agent by mode name.',
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
    func: async (args: any) => {
      // This func will be replaced by the actual handler in getModeInstructionToolHandlers
      throw new Error('Handler not implemented for definition');
    }
  }
];

export function getModeInstructionToolHandlers(memoryManager: MemoryManager) {
  return {
    'add_mode': async (args: any, agent_id: string) => {
      try {
        const instruction_id = await memoryManager.modeInstructionManager.storeModeInstruction(
          agent_id,
          args.mode_name,
          args.instruction_content,
          args.instruction_version
        );
        return { content: [{ type: 'text', text: `Mode instruction added with ID: ${instruction_id}` }] };
      } catch (error: any) {
        console.error('Error storing mode instruction:', error);
        return { content: [{ type: 'text', text: `Error: ${error.message}` }] };
      }
    },
    'get_mode': async (args: any, agent_id: string) => {
      try {
        const instruction = await memoryManager.modeInstructionManager.getModeInstruction(
          agent_id,
          args.mode_name,
          args.instruction_version
        );
        if (instruction) {
          return { content: [{ type: 'text', text: JSON.stringify(instruction, null, 2) }] };
        } else {
          return { content: [{ type: 'text', text: 'No mode instruction found.' }] };
        }
      } catch (error: any) {
        console.error('Error retrieving mode instruction:', error);
        return { content: [{ type: 'text', text: `Error: ${error.message}` }] };
      }
    },
    'delete_mode': async (args: any, agent_id: string) => {
      try {
        const changes = await memoryManager.modeInstructionManager.deleteModeInstruction(
          agent_id,
          args.mode_name,
          args.instruction_version
        );
        return { content: [{ type: 'text', text: `Deleted ${changes} mode instruction(s).` }] };
      } catch (error: any) {
        console.error('Error deleting mode instruction:', error);
        return { content: [{ type: 'text', text: `Error: ${error.message}` }] };
      }
    },
    'update_mode': async (args: any, agent_id: string) => {
      try {
        const instruction_id = await memoryManager.modeInstructionManager.storeModeInstruction(
          agent_id,
          args.mode_name,
          args.instruction_content,
          args.instruction_version
        );
        return { content: [{ type: 'text', text: `Mode instruction updated with ID: ${instruction_id}` }] };
      } catch (error: any) {
        console.error('Error updating mode instruction:', error);
        return { content: [{ type: 'text', text: `Error: ${error.message}` }] };
      }
    }
  };
}
