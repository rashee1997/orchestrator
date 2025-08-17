import { z } from 'zod';

export const TaskSchema = z.object({
  task_number: z.number(),
  title: z.string(),
  description: z.string(),
  purpose: z.string(),
  suggested_files_involved: z.array(z.string()).optional(),
  code_content: z.string().optional(),
  completion_criteria: z.string().optional(),
  dependencies_task_ids_json: z.array(z.string()).optional(),
});

export const GeminiPlannerResponseSchema = z.object({
  plan_title: z.string().optional(),
  estimated_duration_days: z.number(),
  target_start_date: z.string(),
  target_end_date: z.string(),
  plan_risks_and_mitigations: z.array(
    z.object({
      risk_description: z.string(),
      mitigation_strategy: z.string(),
    })
  ),
  tasks: z.array(TaskSchema).optional(),
});
