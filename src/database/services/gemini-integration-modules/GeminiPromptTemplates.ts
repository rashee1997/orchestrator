// ============================================================================
// General Purpose & Summarization Prompts
// ============================================================================

export const SUMMARIZE_CONTEXT_PROMPT = `Summarize the following text concisely:\n\n{textToSummarize}`;

export const SUMMARIZE_CONVERSATION_PROMPT = `
Summarize the following conversation involving agent_id "{agent_id}".
Focus on:
- Key topics discussed
- Main actions taken
- Important decisions made
- Next steps identified
- Any unresolved issues
        
Conversation Messages:
{conversationMessages}

Provide a concise yet comprehensive summary structured as:
1. Overview
2. Key Points
3. Action Items
4. Open Questions`;

export const SUMMARIZE_CORRECTION_LOGS_PROMPT = `You are an expert AI assistant specialized in analyzing correction logs to identify patterns of mistakes and provide clear, actionable instructions to prevent recurrence. Carefully review the following correction logs and produce a concise, prioritized list of past mistakes along with strict guidelines the agent must follow to avoid repeating these errors. Emphasize clarity, specificity, and practical advice.\n\nCorrection Logs:\n{textToSummarize}`;


export const GENERATE_CONVERSATION_TITLE_PROMPT = `
You are an AI assistant specialized in summarizing conversation topics. Your task is to generate a concise, descriptive title for a new conversation session based on the initial user query. The title should be short (under 10 words) and accurately reflect the main topic or purpose of the conversation.

Initial User Query: "{initial_query}"

Concise Conversation Title:`;


// ============================================================================
// Code Analysis, Generation, and Embedding Prompts
// ============================================================================

export const DETECT_LANGUAGE_PROMPT = `Analyze the following code snippet and identify its primary programming language.
Respond with only the lowercase name of the language (e.g., "python", "javascript", "java", "csharp", "html", "css", "unknown" if not identifiable or not code).

Snippet:
{fileContentSnippet}

Language:`;

export const GENERATE_MEANINGFUL_ENTITY_NAME_PROMPT = `You are an expert software engineer. Analyze the following code snippet and provide a very concise (2-5 words) and meaningful name that describes its primary purpose or functionality. 
The name should be suitable for an entity identifier and should not include any punctuation or special characters, only alphanumeric and underscores.
Focus on the core functionality rather than implementation details.
Code snippet (language: {language}):
\`\`\`{language}
{codeChunk}
\`\`\`
Concise Name:`;

export const BATCH_SUMMARIZE_CODE_CHUNKS_PROMPT = `You are an expert code analyst. Your task is to provide a concise, one-sentence summary in plain English explaining the purpose of the following code snippet.
Do not describe the code line-by-line. Focus on the high-level goal and functionality.
Language: {language}
Entity Type: {entityType}
Code Snippet:
\`\`\`{language}
{codeChunk}
\`\`\`
One-sentence summary:`;

export const CHUNK_FILE_SUMMARY_PROMPT = `You are a senior software engineer. Create a concise, high-level summary of the following code file.
Focus on the file's primary purpose, key responsibilities, and how it might interact with other parts of a larger application.
File Path: \`{relativeFilePath}\`
Language: {language}
\`\`\`{language}
{fileContent}
\`\`\`
Concise Summary:`;

export const SUMMARIZE_CODE_CHUNK_PROMPT = `
You are an expert code analyst. Your task is to provide a concise, one-sentence summary in plain English explaining the purpose of the following code snippet.
Do not describe the code line-by-line. Focus on the high-level goal and functionality.

Language: {language}
Entity Type: {entityType}
Code Snippet:
\`\`\`{language}
{codeChunk}
\`\`\`

One-sentence summary:
`;


// ============================================================================
// Query & Intent Classification Prompts
// ============================================================================

export const QUERY_CLASSIFICATION_PROMPT = `
You are a query classification expert. Your task is to classify the user's query into one of two categories based on its intent.

**Categories:**
-   **lookup**: The user is asking for the location or definition of a specific, named entity (e.g., a function, class, or file). Queries like "find...", "where is...", "show me the code for...".
-   **analysis**: The user is asking for an explanation of a process, logic, or a relationship between components. Queries like "how does...", "why...", "describe the lifecycle...", "explain the data flow...".

**Instructions:**
1.  Analyze the user's query.
2.  Respond with **ONLY** the category name: \`lookup\` or \`analysis\`.
3.  Do not add any other text, explanation, or punctuation.

**User Query:**
"{query}"
`;

export const INTENT_CLASSIFICATION_PROMPT = `
You are a highly efficient intent classification AI. Your task is to analyze the user's query and determine which of the following categories it best fits into.

**Available Categories:**
-   code_review
-   code_explanation
-   enhancement_suggestions
-   bug_fixing
-   refactoring
-   testing
-   documentation
-   code_modularization_orchestration
-   codebase_analysis

**Instructions:**
1.  Read the user's query carefully.
2.  Choose the single best category from the list above that matches the user's intent.
3.  Your response MUST be ONLY the chosen category name (e.g., "bug_fixing").
4.  Do NOT add any other words, explanations, or punctuation.

**User Query:**
"{query}"
`;

export const EXTRACT_ENTITIES_PROMPT = `Extract key entities and keywords from the following text. Provide the output as a JSON object with two arrays: "entities" and "keywords".\n\nText:\n{textToExtractFrom}`;


// ============================================================================
// Knowledge Graph Prompts
// ============================================================================
export const NLP_QUERY_PROMPT_TEMPLATE = `You are an expert in translating natural language questions about software codebases into a structured query for a knowledge graph.
The knowledge graph contains nodes representing files, directories, functions, classes, interfaces, modules, and variables.
Node observations often include 'absolute_path', 'language', 'signature', 'lines', 'defined_in_file'.
Key relation types include: 'contains_item', 'imports_file', 'imports_module', 'defined_in_file', 'has_method', 'calls_function', 'uses_class'.

Given a natural language query, translate it into a JSON array of operation objects. Each object must have an "operation" and "args" field.

Supported operations and their 'args' structure:
1. 'search_nodes': args = { "query": "key:value key2:value2 ..." }
   - The "query" string uses key:value pairs. Supported keys: 'entityType', 'name', 'file', 'obs', 'id', 'limit', 'defined_in_file_path', 'parent_class_full_name'.
   - This is for finding nodes based on their properties.
   - Example NLQ: "Find all functions in 'src/utils.ts' that mention 'format'"
   - Translation: [{ "operation": "search_nodes", "args": { "query": "entityType:function file:src/utils.ts obs:format" } }]

2. 'open_nodes': args = { "names": ["exact_node_name1", "exact_node_name2"] }
   - Use for fetching specific nodes by their exact names.

3. 'graph_traversal': args = { "start_node": "node_name", "relation_types": ["relation1"], "depth": number }
   - Use for FORWARD (OUTGOING) traversal from a starting node.
   - Answers questions like "What does X call?", "What does Y import?".
   - Example NLQ: "What functions does 'AuthService' call?"
   - Translation: [{ "operation": "graph_traversal", "args": { "start_node": "AuthService", "relation_types": ["calls_function"], "depth": 1 } }]

4. 'find_inbound_relations': args = { "target_node_name": "node_name", "relation_type": "relation_name" }
   - Use for INVERSE (INCOMING) traversal to find source nodes.
   - Answers questions like "Who calls X?", "Which files import Y?", "Where is Z used?".
   - Example NLQ: "Who calls the 'processAndRefinePrompt' function?"
   - Translation: [{ "operation": "find_inbound_relations", "args": { "target_node_name": "processAndRefinePrompt", "relation_type": "calls_function" } }]
   - Example NLQ: "Which files import 'CodebaseContextRetrieverService'?"
   - Translation: [{ "operation": "find_inbound_relations", "args": { "target_node_name": "CodebaseContextRetrieverService", "relation_type": "imports_file" } }]

5. 'read_graph': args = {}
   - Use only if the query is very general like "show me the graph".

Knowledge Graph Structure (or summary):
---
\${graphRepresentation}
---

Natural Language Query: "\${naturalLanguageQuery}"

---
Instructions for translation:
1. Analyze the NLQ and choose the most appropriate "operation(s)".
2. If the query asks about what a node DOES (e.g., calls, contains, imports), use 'graph_traversal'.
3. If the query asks about WHO acts upon a node (e.g., callers of, importers of, users of), use 'find_inbound_relations'.
4. If a query asks for multiple distinct items (e.g., "Find class A and function B"), break it down into multiple separate operations in the array.
   - Example NLQ: "Show me the GeminiApiClient class and the batchAskGemini method"
   - Translation: [{ "operation": "open_nodes", "args": { "names": ["GeminiApiClient"] } }, { "operation": "open_nodes", "args": { "names": ["batchAskGemini"] } }]
5. If the query asks for a process description, implementation details, or "how" something works (e.g., "how are API keys managed?"), it requires code analysis beyond simple graph lookups. In this case, return a single error operation.
   - Example NLQ: "how are API keys managed in GeminiApiClient?"
   - Translation: [{ "operation": "error", "args": { "message": "Could not translate query: This query requires code analysis of implementation details. Consider using a RAG tool like 'ask_gemini' with codebase context." } }]
6. If the query cannot be reasonably translated for other reasons, return a single error operation:
   [{ "operation": "error", "args": { "message": "Could not translate query: [brief explanation]" } }]

Translate the above Natural Language Query into the structured JSON array format. Provide ONLY the JSON array.
`;
// ============================================================================
// Plan & Task Management Prompts
// ============================================================================

export const AI_SUGGEST_SUBTASKS_PROMPT = `You are an expert project manager AI. Your task is to break down a given parent task into a list of smaller, actionable subtasks.
You have been given the context of all other tasks in the plan to identify logical dependencies.

**Parent Task to Decompose:**
- **ID:** "{taskId}"
- **Title:** "{taskTitle}"
- **Description:** "{taskDescription}"

**Other Tasks in the Plan (for dependency context):**
{otherTasksContext}

Please generate up to {maxSuggestions} subtasks for the parent task. Format your response as a JSON array of objects.
{jsonOutputSchemaInstructions}`;


export const AI_TASK_COMPLEXITY_ANALYSIS_PROMPT = `You are an expert Task Complexity Analyzer AI. Your role is to analyze each task and provide a detailed complexity assessment.

For each task, provide:
- Complexity Score (1-10, where 10 is extremely complex)
- Specific Complexity Factors (list the reasons why this task is complex)
- Detailed Reasoning (explain your analysis)
- Recommended Action (HIGH_COMPLEXITY_SUBTASKS, MEDIUM_COMPLEXITY_SUBTASKS, LOW_COMPLEXITY_NO_SUBTASKS, or SKIP_COMPLETELY)

**Complexity Guidelines:**
- HIGH_COMPLEXITY_SUBTASKS (8-10): Multi-step, multi-system, requires detailed planning, parallel execution
- MEDIUM_COMPLEXITY_SUBTASKS (5-7): Several steps, some technical complexity, moderate planning needed
- LOW_COMPLEXITY_NO_SUBTASKS (1-4): Simple, straightforward, single-step tasks.
- SKIP_COMPLETELY: Administrative, trivial, or already too detailed.

**Special Instruction:** You MUST recommend \`HIGH_COMPLEXITY_SUBTASKS\` or \`MEDIUM_COMPLEXITY_SUBTASKS\` ONLY IF the task's title or description explicitly contains keywords indicating code-related work, such as "code changes", "implementation", "development", "bug fix", "refactoring", "unit tests", or "integration tests". For all other tasks, you MUST recommend \`LOW_COMPLEXITY_NO_SUBTASKS\` or \`SKIP_COMPLETELY\`.

Tasks to analyze:
{tasksToAnalyzeJson}

Respond with a JSON array of objects with this exact structure:
[{
  "task_id": "string",
  "title": "string",
  "complexity_score": number,
  "complexity_factors": ["string"],
  "reasoning": "string",
  "recommended_action": "string"
}]

Provide ONLY the JSON array.`;

export const AI_SUGGEST_TASK_DETAILS_PROMPT = `You are an expert project planner AI. Your task is to flesh out the details for a given task.
The goal is to provide comprehensive information that would be useful for someone picking up this task.

Task Title: "{taskTitle}"
Current Task Description: "{taskDescription}"
{codebaseContext}
Please suggest the following details for this task. Format your response as a single JSON object.
If a detail is not applicable or cannot be reasonably inferred, use null or an empty array.

JSON Output Schema:
{
  "task_id": "{taskId}",
  "suggested_description": "string (A more detailed explanation of what the task involves, expanding on the title and current description. 2-4 sentences.)",
  "suggested_purpose": "string (The reason this task is necessary for the overall plan/goal. 1-2 sentences.)",
  "suggested_action_description": "string (A high-level summary of the primary action(s) to be performed. 1-2 sentences.)",
  "suggested_files_involved": ["string"],
  "suggested_dependencies_task_ids": ["string"],
  "suggested_tools_required_list": ["string"],
  "suggested_inputs_summary": "string (What information or resources are needed to start this task?)",
  "suggested_outputs_summary": "string (What are the expected deliverables or outcomes of this task?)",
  "suggested_success_criteria_text": "string (How will we know this task is completed successfully? Be specific and measurable if possible.)",
  "suggested_estimated_effort_hours": "number (integer, e.g., 1, 2, 4, 8)",
  "suggested_verification_method": "string (How will the completion and correctness of this task be verified?)",
  "rationale_for_suggestions": "string (Briefly explain your reasoning for these suggestions, especially if codebase context was used.)"
}

Provide only the JSON object.`;

export const AI_ANALYZE_PLAN_PROMPT = `You are an expert AI project analyst. Your task is to critically analyze the provided project plan.
The plan includes an overall goal, a list of tasks, and potentially subtasks.

Focus on the following areas during your analysis:
{focusAreas}

Plan Details:
---
{planStringRepresentation}
---
{codebaseContext}
Please provide your analysis as a single JSON object with the following fields. Be thorough and provide actionable insights.

JSON Output Schema:
{
  "plan_id": "{planId}",
  "overall_coherence_score": "number (1-10, 10 being best)",
  "clarity_of_goal_score": "number (1-10)",
  "actionability_of_tasks_score": "number (1-10)",
  "completeness_score": "number (1-10, considering if crucial steps are missing)",
  "identified_strengths": ["string"],
  "potential_risks_or_issues": [{"risk": "string", "mitigation_suggestion": "string", "related_tasks": ["string"]}],
  "missing_tasks_or_steps": ["string"],
  "dependency_concerns": ["string"],
  "resource_allocation_comments": "string",
  "suggestions_for_improvement": ["string"],
  "codebase_context_impact": "string (How codebase context influenced this analysis)",
  "overall_summary": "string (A concise overall summary of your analysis)"
}

Provide only the JSON object.`;

// --- Prompts from GeminiPlannerService ---

export const PLANNER_SYSTEM_INSTRUCTION_REFINED_PROMPT = `You are an expert project planning assistant and senior software engineer with expertise in risk mitigation and realistic project planning.

You will be given a structured input object and your task is to generate a **comprehensive, risk-mitigated project plan** in JSON format.

⚠️ CRITICAL OUTPUT RULES
- You MUST output ONLY a valid JSON object with NO additional text, markdown, or explanations.
- Start your response directly with \`{\` and end with \`}\`.
- Do NOT include \`\`\`json\` markers or any other formatting.
- The JSON must strictly follow the exact schema below with no extra fields.

**JSON String Escaping Rules:**
- For any multiline strings (like in \`description\` or \`code_content\`), you MUST escape characters correctly:
  - Escape all backslashes (\`\\\`) as \`\\\\\`.
  - Escape all newline characters as \`\\n\`.
  - Escape all double quotes (\`"\`) as \`\\"\`.

Required JSON Schema:
{
  "plan_title": "string (max 10 words)",
  "estimated_duration_days": number,
  "target_start_date": "YYYY-MM-DD",
  "target_end_date": "YYYY-MM-DD",
  "kpis": ["string (e.g., 'Reduce response time by 30%', 'Improve accuracy by 25%', 'Reduce error rate to <5%')"],
  "dependency_analysis": "string (Comprehensive explanation of task interdependencies, critical paths, and potential blockers, explicitly noting whether tasks incrementally modify shared resources (like memory_manager.ts) or if a consolidated change is expected at a later stage.)",
  "plan_risks_and_mitigations": [
    {
      "risk_description": "string (specific technical, timeline, or resource risk)",
      "mitigation_strategy": "string (concrete, actionable mitigation with responsible party and timeline, including clear rollback procedures and verification steps)"
    }
  ],
  "tasks": [
    {
      "task_number": number,
      "title": "string (≤ 10 words, non-empty)",
      "description": "string (detailed explanation with technical considerations)",
      "purpose": "string (why this task is necessary and its value proposition)",
      "estimated_duration_days": "number (realistic, not optimistic)",
      "estimated_effort_hours": "number (realistic estimate in hours)",
      "assigned_to": "string (e.g., 'Team A', 'Frontend Dev', 'AI Agent')",
      "suggested_files_involved": ["array", "of", "file", "paths"],
      "code_content": "string (PRODUCTION-READY code with error handling, logging, and tests)",
      "completion_criteria": "string (specific, measurable, testable criteria)",
      "dependencies_task_ids_json": ["array", "of", "task", "title", "strings"],
      "risks": ["array", "of", "specific", "task-level", "risks"],
      "required_skills": ["array", "of", "skills", "or", "expertise", "needed"]
    }
  ]
}

Task Generation Rules:
1. **Realistic Timeline**: Use conservative time estimates. Complex tasks should be 3-7 days minimum. Total project should be 2-4 weeks for typical implementations.
2. **No Placeholders**: For ALL coding tasks, provide COMPLETE, PRODUCTION-READY code with proper error handling, logging, input validation, and performance considerations.
3. **Risk-First Approach**: Identify risks early and build mitigation strategies into the plan structure.
4. **Measurable Success**: Every task must have specific, quantitative completion criteria and KPIs.
5. **Comprehensive Dependencies**: Map out ALL interdependencies, including external systems, APIs, and resource constraints. Explicitly clarify if tasks involve incremental modifications to shared resources (like memory_manager.ts) or if a consolidated change is expected at a later stage.
6. **Quality Gates**: Include explicit quality assurance tasks, code reviews, testing phases, and validation steps. Always include a dedicated task for refactoring or updating existing unit tests affected by the changes.
7. **Resource Planning**: Specify required skills, tools, and infrastructure for each task. Provide realistic estimated_effort_hours and assigned_to values for each task.
8. **Contingency Planning**: Include buffer time and alternative approaches for critical path tasks. Always define clear, step-by-step rollback procedures and verification steps.

Code Content Rules:
- **NEW Files**: Complete, documented source code with error handling, logging, and unit tests
- **EXISTING Files**: Valid unified diffs that maintain system integrity and include proper error handling
- **NEVER Use**: "// TODO", "placeholder", "implement later", or empty implementations
- **ALWAYS Include**: Input validation, error handling, logging, performance considerations

Quality Requirements:
- Include unit tests and integration tests for all code
- Add performance monitoring and alerting
- Implement proper error handling and graceful degradation
- Include comprehensive documentation and code comments
- Plan for scalability and maintainability

FINAL REMINDER: Output ONLY the JSON object. No explanations, no markdown, no additional text.`;

export const PLANNER_USER_QUERY_REFINED_PROMPT = `Analyze the following 'Refined Prompt Object' and generate a complete project plan. Today's date is {today}. Use this for start and end dates.

Refined Prompt Object:
{payloadJson}

Consider the following codebase context and live file content when generating the plan and tasks:
Refined Prompt Context Summary:
{contextSummary}

Live File Content:
{liveFilesString}

Generate a JSON object with this EXACT structure:
{
  "plan_title": "string (max 10 words)",
  "estimated_duration_days": number,
  "target_start_date": "YYYY-MM-DD",
  "target_end_date": "YYYY-MM-DD",
  "plan_risks_and_mitigations": [
    {
      "risk_description": "string",
      "mitigation_strategy": "string"
    }
  ],
  "tasks": [
    {
      "task_number": number,
      "title": "string (≤ 10 words, non-empty)",
      "description": "string (detailed explanation)",
      "purpose": "string (why this task is necessary)",
      "suggested_files_involved": ["array", "of", "file", "paths"],
      "code_content": "string (full code for new files OR unified diff for existing files)",
      "completion_criteria": "string (measurable criteria)",
      "dependencies_task_ids_json": ["array", "of", "task", "title", "strings"]
    }
  ]
}

IMPORTANT: Output ONLY the JSON object. Do NOT include any explanations, markdown, or additional text. Start with { and end with }.`;

export const PLANNER_SYSTEM_INSTRUCTION_GOAL_PROMPT = `You are an expert project planning assistant. Your task is to take a user's high‑level goal and break it down into a structured and detailed project plan. The plan should include an overall goal, estimated duration, start/end dates (use placeholder dates like YYYY‑MM‑DD if specific dates are not inferable), potential risks and mitigations, and a list of actionable high‑level tasks.

Each task **must** contain a non‑empty \`title\` (≤ 10 words) and a non‑empty \`description\`. Do not emit placeholders such as “Untitled Task”.

Enhancements:
• Consolidate redundancy.  
• Explicit dependencies.  
• Add missing critical phases (code review, integration testing, performance profiling, documentation, deployment).  
• Refined task descriptions with completion criteria and required roles/skills.  
• Comprehensive details for each task (estimated effort, risks, micro‑steps, suggested files).`;

export const PLANNER_USER_QUERY_GOAL_PROMPT = `Analyze the following user goal and generate a detailed project plan. Today's date is {today}. Use this for start and end dates.

User Goal:
"{goal}"

Codebase context:
\`\`\`
{codebaseContext}
\`\`\`
Live File Content for analysis:
\`\`\`
{liveFilesString}
\`\`\`

Provide a JSON object with:
1. plan_title (max 10 words)
2. overall_plan_goal (re-phrased)
3. estimated_duration_days (integer)
4. target_start_date ("YYYY-MM-DD", today = {today})
5. target_end_date (calculated)
6. plan_risks_and_mitigations: an array of objects, each with "risk_description" and "mitigation_strategy" string properties.
7. tasks: an array of task objects, each containing:
   - task_number (integer)
   - title (string)
   - description (string)
   - purpose (string)
   - suggested_files_involved (array of strings)
   - code_content (string, either full code for new files or a diff for existing files, mandatory for coding tasks)
   - completion_criteria (string)
   - dependencies_task_ids_json (array of strings, referencing other task titles)

Return ONLY the JSON object.`;


// ============================================================================
// Enhanced RAG (Retrieval-Augmented Generation) Prompts - 2025 Edition
// Featuring: Agentic Planning, Reflection, Hybrid Search, Citations, Corrective RAG
// ============================================================================

export const RAG_DECISION_PROMPT = `
You are an advanced RAG optimization agent with intelligent decision-making capabilities for 2025 RAG systems. Your task is to analyze conversation context and determine the most efficient retrieval strategy using enhanced decision criteria.

**ENHANCED DECISION CAPABILITIES:**
- Context sufficiency analysis with quality scoring
- Strategic RAG approach selection (vector, graph, hybrid, web)
- Query optimization and reformulation
- Citation and source quality assessment
- Progressive information building analysis

**Your Goal:** Optimize information retrieval by intelligently deciding between conversation reuse, targeted RAG search, or enhanced multi-modal retrieval.

**COMPREHENSIVE ANALYSIS FRAMEWORK:**

1. **Conversation Context Analysis:**
   - Information completeness and quality assessment
   - Source reliability and recency evaluation
   - Gap identification and missing information analysis
   - Technical depth and implementation detail sufficiency

2. **Query Intent Classification:**
   - Information seeking vs. clarification requests
   - Technical depth requirements
   - Implementation detail needs
   - Comparative analysis requirements

3. **Strategic Retrieval Planning:**
   - Optimal search modality selection
   - Query reformulation for maximum effectiveness
   - Citation and attribution requirements
   - Quality threshold establishment

**ENHANCED OUTPUT FORMAT:**
Provide a comprehensive decision analysis:

\`\`\`json
{
  "decision": "ANSWER_FROM_HISTORY | PERFORM_SIMPLE_RAG | PERFORM_ENHANCED_RAG | PERFORM_HYBRID_RAG",
  "confidence_score": 0.0-1.0,
  "context_analysis": {
    "sufficiency_score": 0.0-1.0,
    "quality_score": 0.0-1.0,
    "completeness_assessment": "complete|partial|insufficient",
    "identified_gaps": ["specific missing information areas"]
  },
  "rag_strategy": {
    "primary_query": "optimized query for RAG system or null",
    "search_modality": "vector|graph|hybrid|web|multi_modal",
    "complexity_level": "simple|moderate|comprehensive",
    "expected_sources": ["types of sources expected to provide answers"],
    "quality_targets": {
      "minimum_relevance": 0.0-1.0,
      "citation_requirements": "specific|general|comprehensive",
      "depth_requirement": "overview|detailed|comprehensive"
    }
  },
  "fallback_strategy": "alternative approach if primary strategy fails",
  "reasoning": "detailed explanation of decision rationale",
  "estimated_value": "high|medium|low value of performing RAG vs using history"
}
\`\`\`

**ENHANCED DECISION CRITERIA:**

- **ANSWER_FROM_HISTORY:** History contains comprehensive, high-quality information (completeness >0.9, quality >0.8)
- **PERFORM_SIMPLE_RAG:** Need specific additional details, simple vector search sufficient
- **PERFORM_ENHANCED_RAG:** Complex query requiring multi-turn search with quality assurance
- **PERFORM_HYBRID_RAG:** Need combination of semantic and structural information, multi-modal approach

**QUERY OPTIMIZATION RULES:**
- Transform contextual references into self-contained queries
- Include domain-specific terminology from conversation context
- Specify technical depth and implementation detail requirements
- Design queries for optimal citation and source attribution
- Consider progressive information building for complex topics

---
**<conversation_history>**
{conversation_history}
**</conversation_history>**

---
**<new_query>**
{new_query}
**</new_query>**
---

**For backward compatibility:** If you need to provide the simple format, use the "primary_query" field as "rag_query" and map decision types to the original format.

Provide your comprehensive analysis:
`;

export const RAG_ANALYSIS_PROMPT = `You are an advanced agentic search orchestrator powered by 2025 RAG technology. Your goal is to strategically gather information through multiple modalities to comprehensively answer the user's query.

**AGENTIC CAPABILITIES:**
- Strategic planning with adaptive search strategies
- Multi-modal information fusion (vector, graph, web)
- Self-reflection and quality assurance
- Corrective search based on gap analysis
- Citation-aware response generation

Original Query: "{originalQuery}"
Current Search Turn: {currentTurn} of {maxIterations}
{focusString}
---
Accumulated Context So Far:
{accumulatedContext}
---
Current Search Strategy: {currentStrategy}
Previous Quality Score: {previousQuality}
Citation Coverage: {citationCoverage}
---

**ENHANCED DECISION FRAMEWORK:**
Analyze the context and choose the most effective next action.

Respond in this exact format:
Decision: [ANSWER|SEARCH_AGAIN|SEARCH_WEB|HYBRID_SEARCH|CORRECTIVE_SEARCH|REFLECT]
Strategy: [vector_search|graph_traversal|hybrid_search|web_augmented|corrective_search|reflection]
Reasoning: [Detailed analysis of information gaps, context quality, and strategic rationale for chosen approach]
Next Codebase Search Query: [Only if decision involves codebase search - specific, targeted query]
Next Web Search Query: [Only if decision is SEARCH_WEB - concise web search query]
Next Graph Query: [Only if using graph traversal - entity relationships to explore]
Quality Assessment: [Score 0.0-1.0 - assess current context quality and completeness]
Missing Information: [Specific gaps that need to be filled]
Citation Targets: [What sources/entities should be cited in the final answer]
Confidence: [0.0-1.0 confidence in this strategic decision]
Fallback Strategy: [Alternative approach if current strategy fails]
---

**ENHANCED INSTRUCTIONS & STRATEGY:**
- **Agentic Planning:** Adapt your search strategy based on context quality and information gaps
- **Multi-Modal Fusion:** Combine vector similarity, knowledge graph relationships, and web sources intelligently
- **Quality-First Approach:** Prioritize information quality and source reliability over quantity
- **Strategic Diversification:** Use different search modalities to build comprehensive understanding
- **Self-Reflection:** Periodically assess context quality and adjust strategy accordingly
- **Citation Awareness:** Identify key sources that should be cited in the final answer
- **Gap Analysis:** Explicitly identify what information is missing and why it's needed
- **Corrective Search:** When previous searches fail, use reflection to reformulate approach
- **Hybrid Intelligence:** Combine structured (graph) and unstructured (vector) search when beneficial
- **Final Turn Strategy:** On turn {maxIterations}, choose ANSWER with comprehensive citation plan

**DECISION CRITERIA:**
- **ANSWER:** Context is comprehensive, quality score >0.8, all query aspects covered
- **SEARCH_AGAIN:** Need specific additional information, clear gap identified
- **SEARCH_WEB:** Information cannot exist in codebase (standards, best practices, external APIs)
- **HYBRID_SEARCH:** Complex query requiring both semantic and structural understanding
- **CORRECTIVE_SEARCH:** Previous searches failed, need alternative approach based on reflection
- **REFLECT:** Context quality unclear, need to assess completeness and accuracy
`;


export const RAG_ANALYSIS_SYSTEM_INSTRUCTION = `You are an advanced agentic RAG orchestrator with strategic planning capabilities. You must analyze the context comprehensively and make intelligent decisions about search strategies.

**CORE COMPETENCIES:**
- Strategic search planning and adaptation
- Multi-modal information synthesis
- Quality assessment and gap analysis
- Citation-aware response generation
- Self-reflection and corrective reasoning

**OUTPUT REQUIREMENTS:**
- Follow the exact format specified in the user prompt
- Provide detailed strategic reasoning for each decision
- Include quality assessments and gap analysis
- Suggest specific, actionable next steps
- Maintain consistency with agentic planning principles

**PRECISION MANDATE:** Your output must be in the exact format specified. Do not deviate from the required structure.`;

export const RAG_VERIFICATION_PROMPT = `You are an advanced AI quality assurance agent specialized in reflection-based verification for RAG systems. Your task is to perform comprehensive fact-checking and quality assessment of generated responses.

**ENHANCED VERIFICATION CAPABILITIES:**
- Hallucination detection with confidence scoring
- Source attribution validation
- Citation accuracy assessment
- Completeness gap analysis
- Quality scoring with improvement suggestions

Original Query: "{originalQuery}"
Context Sources: {contextSources}
Citation Coverage: {citationCoverage}

--- CONTEXT START ---
{contextString}
--- CONTEXT END ---

--- PROPOSED ANSWER START ---
{generatedAnswer}
--- PROPOSED ANSWER END ---

**COMPREHENSIVE VERIFICATION FRAMEWORK:**

1. **Factual Accuracy Check:**
   - Verify each claim against specific context sources
   - Check for invented components, functions, or logic
   - Validate technical details and implementation specifics

2. **Citation Verification:**
   - Ensure all citations reference actual context sources
   - Verify citation accuracy and relevance
   - Check for missing citations on factual claims

3. **Completeness Assessment:**
   - Identify aspects of the original query not addressed
   - Detect missing critical information
   - Assess depth and breadth of response coverage

4. **Quality Analysis:**
   - Evaluate response coherence and organization
   - Check for technical accuracy and precision
   - Assess practical utility and actionability

**ENHANCED RESPONSE FORMAT:**
Provide a detailed JSON assessment:

{
  "verification_status": "VERIFIED|HALLUCINATION_DETECTED|INCOMPLETE|NEEDS_IMPROVEMENT",
  "confidence_score": 0.0-1.0,
  "factual_accuracy": {
    "supported_claims": ["list of verified claims"],
    "unsupported_claims": ["list of unverified/hallucinated claims"],
    "accuracy_score": 0.0-1.0
  },
  "citation_analysis": {
    "valid_citations": number,
    "missing_citations": number,
    "citation_accuracy": 0.0-1.0,
    "source_coverage": 0.0-1.0
  },
  "completeness_assessment": {
    "query_coverage": 0.0-1.0,
    "missing_aspects": ["list of unaddressed query aspects"],
    "depth_score": 0.0-1.0
  },
  "quality_metrics": {
    "coherence_score": 0.0-1.0,
    "technical_accuracy": 0.0-1.0,
    "practical_utility": 0.0-1.0
  },
  "improvement_suggestions": ["specific recommendations for enhancement"],
  "corrective_actions": ["suggested next steps if verification fails"]
}

If verification is successful (all scores >0.8), you may respond with just "VERIFIED" for brevity.`;

export const RAG_ANSWER_PROMPT = `You are an advanced RAG response generator with enhanced citation capabilities and quality assurance. Generate a comprehensive, well-structured answer that synthesizes information from multiple sources with proper attribution.

**ENHANCED RESPONSE CAPABILITIES:**
- Multi-source information synthesis
- Granular citation tracking
- Quality-assured content generation
- Structured response formatting
- Source reliability assessment

Original Query: "{originalQuery}"
Search Strategy Used: {searchStrategy}
Context Quality Score: {contextQuality}
Total Sources: {totalSources}
{focusString}

--- CONTEXT SOURCES ---
{contextString}
--- END CONTEXT ---

**RESPONSE GENERATION REQUIREMENTS:**

1. **Comprehensive Coverage:**
   - Address all aspects of the original query
   - Synthesize information from multiple sources
   - Provide sufficient detail for practical use
   - Include relevant examples and specifics

2. **Enhanced Citation System:**
   - Use format [cite_N] for each factual claim
   - Ensure granular source attribution
   - Include confidence indicators where appropriate
   - Reference specific file paths and line numbers when available

3. **Quality Assurance:**
   - Maintain factual accuracy based solely on provided context
   - Organize information logically and coherently
   - Use clear, professional technical language
   - Provide actionable insights and recommendations

4. **Source Reliability:**
   - Prioritize information from high-confidence sources
   - Acknowledge any limitations in available information
   - Distinguish between definitive facts and inferred details

**RESPONSE STRUCTURE:**

## Executive Summary
[Brief overview addressing the core query]

## Detailed Analysis
[Comprehensive response with proper citations]

## Key Findings
[Bullet points of main insights with citations]

## Implementation Considerations
[Practical guidance and recommendations]

## Source References
[Numbered list of all cited sources with confidence scores]

**CITATION FORMAT:**
Use [cite_N] immediately after claims, where N corresponds to:
- cite_1: [Source path/entity] (confidence: X.XX)
- cite_2: [Source path/entity] (confidence: X.XX)

**QUALITY GATES:**
- Every factual claim must have a citation
- All citations must reference actual context sources
- Response must be comprehensive yet concise
- Technical accuracy is paramount

Generate your comprehensive, citation-rich response:`;

export const RAG_DIVERSE_QUERIES_PROMPT = `
**Role:** You are an advanced agentic query strategist and semantic search optimization specialist. Your task is to generate diverse, strategically-designed queries using the latest 2025 RAG techniques including multi-modal search, agentic planning, and quality-aware retrieval.

**ENHANCED QUERY GENERATION CAPABILITIES:**
- Strategic query diversification with modality awareness
- Context-aware query planning with dependency mapping
- Quality-oriented query design for better retrieval
- Citation-conscious query formulation
- Adaptive query complexity based on domain analysis

**Objective:** Generate {numQueries} semantically and strategically distinct search queries that explore multiple dimensions of the original query using advanced RAG techniques.

Original Query: "{originalQuery}"
Domain Context: {domainContext}
Complexity Level: {complexityLevel}
Expected Modalities: {expectedModalities}

**ENHANCED QUERY GENERATION FRAMEWORK:**

**1. Multi-Modal Query Planning:**
- **Vector Search Queries:** Semantic similarity-based queries for concept discovery
- **Graph Traversal Queries:** Relationship-focused queries for dependency exploration  
- **Hybrid Queries:** Combined semantic and structural queries for comprehensive coverage
- **Web Augmentation Queries:** External knowledge queries for standards and best practices

**2. Strategic Query Categories:**

*   **A. Architectural Overview & System Design:**
    - Focus on high-level system architecture and design patterns
    - *Example:* "System architecture and design patterns used in the authentication module"

*   **B. Component Relationships & Integration Points:**
    - Explore inter-component dependencies and communication patterns
    - *Example:* "Integration patterns and dependencies between AuthService and UserManager components"

*   **C. Implementation Deep Dive & Algorithm Analysis:**
    - Detailed examination of core algorithms and implementation logic
    - *Example:* "Core authentication algorithm implementation including token validation and session management"

*   **D. Data Flow & State Management:**
    - Trace data movement and state transitions through the system
    - *Example:* "User authentication data flow from login request to session establishment"

*   **E. Error Handling & Resilience Patterns:**
    - Focus on error management, validation, and system resilience
    - *Example:* "Comprehensive error handling and retry mechanisms in authentication workflow"

*   **F. Performance & Optimization Strategies:**
    - Examine performance considerations and optimization techniques
    - *Example:* "Performance optimization and caching strategies in user authentication system"

*   **G. Security & Compliance Implementation:**
    - Focus on security measures and compliance requirements
    - *Example:* "Security implementation including encryption, authorization, and audit logging"

*   **H. Configuration & Environment Management:**
    - Investigate configuration patterns and environment-specific behavior
    - *Example:* "Configuration management and environment-specific settings for authentication services"

**3. Query Quality Enhancement:**
- Ensure each query targets specific, retrievable information
- Design queries to maximize citation potential
- Balance breadth and depth for comprehensive coverage
- Include context-aware specificity based on domain expertise

**4. Modality-Specific Optimization:**
- **Vector-Optimized:** Use conceptual language for semantic matching
- **Graph-Optimized:** Focus on relationships and dependencies
- **Hybrid-Optimized:** Combine semantic concepts with structural elements
- **Citation-Optimized:** Target information that can be precisely attributed

**Advanced Constraints:**
- Generate queries with varying complexity levels (simple → complex)
- Ensure queries are mutually complementary, not redundant
- Design queries to build upon each other for progressive understanding
- Include both broad conceptual queries and specific implementation queries
- Avoid generic queries that would overwhelm the retrieval system
- Focus on actionable, implementable information needs

**Enhanced Output Format:**
Provide a JSON object with strategic query organization:

\`\`\`json
{
  "strategic_queries": [
    {
      "query": "specific search query text",
      "category": "architectural_overview|component_relationships|implementation_details|data_flow|error_handling|performance|security|configuration",
      "modality": "vector|graph|hybrid|web",
      "complexity": "simple|moderate|complex",
      "expected_sources": ["file_types or entity_types expected to contain relevant information"],
      "priority": 1-5
    }
  ],
  "query_strategy": "Brief explanation of the overall query strategy and expected synergies",
  "coverage_assessment": "How these queries collectively address the original query"
}
\`\`\`

**Quality Assurance:**
- Each query must be self-contained and actionable
- Queries should collectively provide comprehensive coverage
- Balance between exploratory and targeted queries
- Ensure queries are optimized for the specified modalities
- Design queries to support high-quality citation and attribution
`;

// ============================================================================
// Meta Prompts (High-level task-specific prompts)
// ============================================================================

export const META_PROMPT = `
You are an expert AI prompt engineer and senior software architect. Your task is to take a raw user prompt, perform a deep and mandatory analysis of the provided codebase context, and transform the prompt into a highly structured, detailed, and actionable "Refined Prompt for AI". This refined prompt will be used by another AI agent to execute the user's request with precision.

**CRITICAL INSTRUCTION: Your primary function is to analyze the "Retrieved Codebase Context". Do not ignore it. Your entire output must be based on how the user's request interacts with this existing code.**

**Analysis Steps:**
1.  **Interpret Goal:** Define the user's \`overall_goal\` by interpreting their prompt in light of the provided code context.
2.  **Analyze Context:** In the \`codebase_context_summary_by_ai\` field, summarize how the existing code influences the plan. Is this a new feature, a modification, or a refactor? Which files are most relevant?
3.  **Identify Key Entities:** In the \`relevant_code_elements_analyzed\` field, list the specific functions, classes, and files from the context that will be directly impacted or are crucial for implementation.
4.  **Decompose Tasks:** Break down the goal into a sequence of granular, actionable development tasks. For each task in \`decomposed_tasks\`, provide the exact keys as specified below, as they map directly to a database schema.
5.  **Suggest Dependencies:** For each decomposed task, list the \`title\` of any prerequisite tasks in the \`dependencies_task_ids_json\` field. This is crucial for creating a valid execution plan.
6.  **Suggest Validation:** Propose \`suggested_validation_steps\` for the agent to perform after completing the entire plan, such as running specific tests or querying the knowledge graph to confirm changes.
7.  **Suggest New File Paths:** If the task involves refactoring or creating new files, propose concrete new file paths in the \`suggested_new_file_paths\` field. These paths should be relative to the project root.

**Output Schema:**
You MUST output the refined prompt strictly as a JSON object, adhering exactly to the following schema. Do not include any text or markdown outside the JSON block.

\`\`\`json
{
  "refined_prompt_id": "server_generated_uuid",
  "agent_id": "{agentId}",
  "original_prompt_text": "The exact raw user prompt text.",
  "refinement_engine_model": "{modelToUse}",
  "refinement_timestamp": "YYYY-MM-DDTHH:MM:SS.sssZ",
  "overall_goal": "A clear, concise statement of the user's primary objective, informed by the codebase context.",
  "decomposed_tasks": [
    {
      "title": "A concise, actionable title for the task.",
      "description": "A detailed, step-by-step description of what needs to be done to complete this task.",
      "purpose": "A brief explanation of why this task is necessary for the overall goal.",
      "files_involved_json": ["src/path/to/file1.ts", "src/path/to/file2.ts"],
      "tools_required_list_json": ["apply_file_patch", "run_shell_command"],
      "success_criteria_text": "A clear, verifiable statement of what constitutes successful completion of this task.",
      "dependencies_task_ids_json": ["Title of a prerequisite task from this list."]
    }
  ],
  "key_entities_identified": [ 
    {"type": "filename | function | class", "value": "path/to/file.ts | functionName | ClassName", "relevance_to_prompt": "Identified as highly relevant from codebase context."}
  ],
  "codebase_context_summary_by_ai": "Your mandatory, brief analysis of how the retrieved codebase context influences the interpretation and plan.",
  "relevant_code_elements_analyzed": [
    {
      "element_path": "src/services/payment_service.ts",
      "element_type": "function",
      "entity_name": "processPayment",
      "relevance_notes": "This function currently handles credit card payments and will need to be modified to include the new payment logic."
    }
  ],
  "suggested_validation_steps": [
      "Run all unit tests in 'tests/payment_service.test.ts'.",
      "Query the knowledge graph to ensure the new 'GiftCardService' node is correctly linked to the 'PaymentService'."
  ],
  "suggested_new_file_paths": [
    "path/to/new_module1.ts",
    "path/to/new_module2.ts"
  ],
  "confidence_in_refinement_score": "High | Medium | Low",
  "refinement_error_message": "Null if successful, or an error message if refinement failed."
}
\`\`\`

---
Raw User Prompt:
\`\`\`
{raw_user_prompt}
\`\`\`

---
Retrieved Codebase Context (MANDATORY ANALYSIS):
\`\`\`text
{retrievedCodeContextString}
\`\`\`
---

Now, provide the JSON object only.
`;

export const CODE_REVIEW_META_PROMPT = `You are an expert AI code reviewer with COMPREHENSIVE analysis capabilities. Given the following codebase context and user question, provide a detailed code review with structured analysis and actionable recommendations.

**ENHANCED ANALYSIS FRAMEWORK:**
1. **Code Structure Analysis**: Examine overall architecture, modularity, and organization patterns
2. **Algorithm Implementation Review**: For research/ML code, verify mathematical correctness and implementation accuracy
3. **Performance & Optimization**: Identify bottlenecks, memory issues, and optimization opportunities
4. **Security & Robustness**: Check for vulnerabilities, error handling, and edge cases
5. **Code Quality Metrics**: Evaluate readability, maintainability, and adherence to best practices
6. **Testing Coverage**: Assess test completeness and identify gaps
7. **Documentation Quality**: Review inline docs, comments, and API documentation

**STRUCTURED REVIEW OUTPUT:**
Provide a comprehensive analysis with these sections:

### 🔍 **Critical Issues Found**
- **High Priority**: Bugs, security issues, correctness problems
- **Medium Priority**: Performance issues, maintainability concerns
- **Low Priority**: Style issues, minor improvements

### 📊 **Algorithm/Logic Analysis**
- **Mathematical Correctness**: Verify formulas, algorithms match specifications
- **Logic Flow**: Trace execution paths and identify logical errors
- **Edge Cases**: Check handling of boundary conditions and error states

### ⚡ **Performance Assessment**
- **Computational Complexity**: Analyze time/space complexity
- **Resource Usage**: Memory, CPU, I/O optimization opportunities
- **Scalability**: How well code handles increased load/data

### 🛡️ **Security & Robustness**
- **Input Validation**: Check for proper sanitization and bounds checking
- **Error Handling**: Assess exception handling and recovery mechanisms
- **Security Vulnerabilities**: Identify potential attack vectors

### 📝 **Code Quality Review**
- **Readability**: Code clarity, naming conventions, documentation
- **Maintainability**: Modularity, coupling, technical debt indicators
- **Standards Compliance**: Adherence to language/framework conventions

### 🧪 **Testing Recommendations**
- **Missing Test Cases**: Identify untested functionality
- **Test Quality**: Review existing test coverage and effectiveness
- **Integration Testing**: Suggest component interaction tests

### 📋 **Actionable Recommendations**
For each recommendation, provide:
- **Priority Level**: Critical, High, Medium, Low
- **Specific Changes**: Detailed modification suggestions
- **Implementation Steps**: Clear, step-by-step instructions
- **Expected Benefits**: Quantified improvements (performance, reliability, etc.)

**CODE CHANGE FORMATTING:**
If suggesting code changes, use this format:
\`\`\`diff
// File: src/path/to/file.ts
// Lines: 15-25
- OLD_CODE_HERE
+ NEW_CODE_HERE
\`\`\`

Codebase Context:
{context}
User Question: {query}

Provide a thorough, well-structured review that balances technical depth with practical recommendations.`;

export const CODE_EXPLANATION_META_PROMPT = `You are an expert AI code explainer. Given the following codebase context and user question, provide a detailed and comprehensive explanation of the code. Reference the file paths and entity names from the context in your explanation.`;

export const ENHANCEMENT_SUGGESTIONS_META_PROMPT = `You are an expert AI enhancement suggester. Given the following codebase context and user question, provide suggestions for code improvements and refactoring.

**Your suggestions MUST be 100% accurate and provide a complete refactoring plan if applicable.**

Reference the file paths and entity names from the context in your suggestions. If you suggest code changes, format them using the apply_diff tool's diff format, including the file path and starting line number.

Codebase Context:
{context}
User Question: {query}
Your Response should include:
- Suggestions for code improvements, refactoring, or optimization.
- Identification of potential performance bottlenecks.
- Recommendations for new features or functionality.`;

export const BUG_FIXING_META_PROMPT = `You are an expert AI bug fixer. Given the following codebase context and user question, identify potential bugs and suggest fixes. Reference the file paths and entity names from the context. If you suggest code changes, format them using the apply_diff tool's diff format, including the file path and starting line number.
Codebase Context:
{context}
User Question: {query}
Your Response should include:
- Identification of the root cause of the bug.
- Proposed code changes to fix the bug.
- Suggestions for testing the fix.`;

export const REFACTORING_META_PROMPT = `
You are an expert AI Software Architect and Senior Developer specializing in DETAILED refactoring planning and execution. Your task is to act as a comprehensive planning assistant for complex refactoring tasks with COMPLETE implementation details.

**ENHANCED PLANNING CAPABILITIES:**
- **Comprehensive Impact Analysis**: Identify ALL files, functions, and dependencies affected by the refactoring
- **Detailed Change Specifications**: Provide exact code changes, not just descriptions
- **Implementation-Ready Code**: Generate complete, production-ready code for new components
- **Testing Strategy Integration**: Include test updates and validation steps
- **Risk Assessment & Mitigation**: Identify potential issues and provide solutions
- **Dependency Management**: Map out all dependency relationships and update requirements

**MANDATE:**
Analyze the provided codebase context, understand the user's goal, and generate a detailed, step-by-step refactoring plan that includes:
1. **Complete File Inventory**: Every file that needs modification
2. **Precise Code Changes**: Exact line-by-line changes with context
3. **New Component Implementation**: Full code for new files/classes
4. **Testing & Validation**: Complete test updates and verification steps
5. **Dependency Updates**: All import/export statements and references
6. **Migration Strategy**: Step-by-step execution plan with rollback procedures

**STRUCTURED PLAN FORMAT:**

### 📋 **Refactoring Overview**
- **Primary Goal**: [Clear statement of refactoring objective]
- **Scope**: [Files affected, components changed, functionality impacted]
- **Risk Level**: [High/Medium/Low with justification]
- **Estimated Effort**: [Time and complexity assessment]

### 🔍 **Impact Analysis**
- **Files to Modify**: [Complete list with change types]
- **Dependencies to Update**: [All import/export relationships]
- **Tests to Update**: [Test files requiring modifications]
- **Configuration Changes**: [Config files, environment variables, etc.]

### 📁 **File-by-File Changes**

#### File: \`path/to/file1.ext\`
**Change Type**: [Modification/New File/Deletion]  
**Purpose**: [Why this file needs changes]  
**Dependencies**: [What this file depends on]  

**Specific Changes**:
\`\`\`diff
// Current code at lines X-Y
- OLD_CODE_LINE_1
- OLD_CODE_LINE_2
+ NEW_CODE_LINE_1
+ NEW_CODE_LINE_2
\`\`\`

**New Dependencies**: [Any new imports required]  
**Breaking Changes**: [API changes that affect other components]

#### File: \`path/to/file2.ext\`
[... repeat structure ...]

### 🆕 **New Components Required**

#### Component: [Component Name]
**File**: \`path/to/new/file.ext\`  
**Purpose**: [Why this new component is needed]  

**Complete Implementation**:
\`\`\`language
COMPLETE_CODE_IMPLEMENTATION_HERE
\`\`\`

**Interface Definition**: [Public API this component exposes]  
**Dependencies**: [What this component needs]  
**Test Coverage**: [How this component should be tested]

### 🧪 **Testing Strategy**

#### Unit Tests Updates:
- **File**: \`tests/path/to/test_file.ext\`
- **Changes Required**: [What tests need modification]
- **New Tests Needed**: [Additional test cases]

#### Integration Tests:
- **Test Scenarios**: [End-to-end test requirements]
- **Mock Requirements**: [What needs to be mocked]

### 🔄 **Migration Strategy**

#### Phase 1: Preparation
1. [Step-by-step preparation tasks]
2. [Backup procedures]
3. [Environment setup]

#### Phase 2: Implementation
1. [Ordered list of file changes]
2. [Verification steps after each change]
3. [Rollback procedures]

#### Phase 3: Validation
1. [Testing procedures]
2. [Performance verification]
3. [Compatibility checks]

### ⚠️ **Risk Mitigation**
- **High-Risk Changes**: [Identify and provide workarounds]
- **Fallback Procedures**: [How to rollback if issues occur]
- **Monitoring Requirements**: [What to monitor during and after changes]

### 📊 **Success Metrics**
- **Functional Requirements**: [What must work after refactoring]
- **Performance Benchmarks**: [Speed, memory, scalability requirements]
- **Code Quality Gates**: [Readability, maintainability, test coverage]

### 🚀 **Implementation Timeline**
- **Phase 1**: [X hours/days] - Preparation and analysis
- **Phase 2**: [X hours/days] - Core implementation
- **Phase 3**: [X hours/days] - Testing and validation
- **Total Effort**: [Total estimated time]

**EXECUTION REQUIREMENTS:**
- Provide COMPLETE code implementations, not just skeletons
- Include error handling and edge cases in all new code
- Ensure backward compatibility unless explicitly stated otherwise
- Provide both implementation and rollback procedures
- Include comprehensive testing strategy

---
**Codebase Context:**
{context}

---
**User's Refactoring Goal:**
{query}

---
Now, generate the detailed, step-by-step refactoring plan with complete implementation details.
`;
export const TESTING_META_PROMPT = `You are an expert AI testing assistant. Given the following codebase context and user question, suggest comprehensive and actionable test cases, testing strategies, or ways to improve test coverage.

**Your suggestions MUST be highly accurate and provide a complete plan for testing.**

Reference the file paths and entity names from the context.

Codebase Context:
{context}
User Question: {query}
Your Response should include:
- Suggested unit, integration, or end-to-end test cases.
- Recommendations for testing frameworks or tools.
- Strategies for improving code testability and coverage.`;

export const DOCUMENTATION_META_PROMPT = `You are an expert AI documentation assistant. Given the following codebase context and user question, generate or improve documentation for the code. Reference the file paths and entity names from the context.
Codebase Context:
{context}
User Question: {query}
Your Response should include:
- Clear and concise explanations of code functionality.
- Examples of usage.
- API documentation or inline comments.`;

export const CODE_MODULARIZATION_ORCHESTATION_META_PROMPT = `You are an expert AI software architect specializing in code modularization and refactoring. Given the following codebase context and user question, your task is to propose a comprehensive and actionable plan for modularizing large code files.

**Your suggestions MUST be 100% actionable and provide a complete refactoring plan.**

Reference the file paths and entity names from the context. If you suggest code changes, format them using the apply_diff tool's diff format, including the file path and starting line number.

Your response should include:
-   **Proposed New Folder Structures:** Suggest logical new folder paths (relative to the project root) where extracted code modules should reside.
-   **Extracted Code Modules:** Identify specific code blocks (functions, classes, interfaces, constants, etc.) that should be extracted into new files within the proposed new folders. Provide the exact code to be extracted.
-   **Original File as Orchestrator:** Detail how the original large file should be refactored to become an orchestrator. This includes:
    *   Removing the extracted code.
    *   Adding import statements for the newly created modules.
    *   Adjusting calls to the extracted functionalities to use the new imports.
-   **Dependency Management:** Explain how dependencies between the new modules and the orchestrator file will be managed.
-   **Verification Steps:** Suggest steps to verify the modularization (e.g., running tests, checking imports).

Codebase Context:
{context}
User Question: {query}
`;

export const CODE_ANALYSIS_META_PROMPT = `
You are a meticulous Senior Software Engineer and a highly precise Code Analyst.
Your sole task is to analyze the provided codebase context to answer the user's query.

**CRITICAL INSTRUCTIONS:**
1.  Your entire response **MUST** be based **exclusively** on the information within the provided codebase context.
2.  **DO NOT** invent, assume, or infer any functionality, classes, methods, or logic that is not explicitly present in the files.
3.  Your analysis **MUST** trace the execution flow starting from the entry point mentioned in the user's query or the most logical entry point in the context (e.g., \`askGeminiToolDefinition.func\`).
4.  Reference specific file paths, class names, and method names from the context to support every part of your analysis.
5.  If the context is insufficient to answer the query, you **MUST** state that explicitly and explain what is missing. Do not try to fill in the gaps.

---
**Codebase Context:**
{context}

---
**User's Analysis Query:**
{query}
---
`;

export const DEFAULT_CODEBASE_ASSISTANT_META_PROMPT = `You are a helpful AI assistant that answers questions about the given codebase. Use the context provided to answer the question. Reference the file paths and entity names from the context in your answer.`;

// This prompt prioritizes conversation history with enhanced context management.
export const CONVERSATIONAL_CODEBASE_ASSISTANT_META_PROMPT = `
You are a helpful and context-aware AI assistant specializing in MAINTAINING CONVERSATION CONTINUITY and providing ACCURATE, CONTEXT-AWARE responses. Your primary goal is to answer the user's latest query by intelligently synthesizing information from ongoing conversation history and supplemental codebase context.

**ENHANCED CONTEXT PROCESSING CAPABILITIES:**
1. **Conversation Flow Analysis**: Track discussion progression, identify unresolved questions, and maintain logical continuity
2. **Context Relevance Scoring**: Assess which parts of codebase context are most relevant to the current discussion
3. **Information Synthesis**: Combine conversation history with code context to provide comprehensive answers
4. **Knowledge Preservation**: Maintain technical details and decisions made throughout the conversation
5. **Progressive Disclosure**: Provide information at appropriate detail levels based on conversation stage

**CRITICAL INSTRUCTIONS:**
1. **Conversation-First Approach**: Analyze conversation history to understand the full context, intent, and progression of the discussion. The conversation history is your primary source of truth.

2. **Intelligent Context Integration**: Use "Retrieved Codebase Context" strategically:
   - **Verification**: Confirm technical details mentioned in conversation
   - **Expansion**: Provide additional relevant information from codebase
   - **Examples**: Supply specific code references when discussing implementation
   - **Clarification**: Resolve ambiguities with concrete code evidence

3. **Contextual Response Generation**:
   - **Synthesize**: Create coherent answers that blend conversation context with code knowledge
   - **Reference**: Always cite specific file paths and entity names from codebase context
   - **Connect**: Show how codebase information relates to previous conversation points
   - **Progress**: Advance the conversation by addressing unanswered questions or unresolved points

4. **Response Optimization**:
   - **Conciseness**: Provide focused answers that directly address the query
   - **Technical Depth**: Adjust technical detail based on conversation sophistication level
   - **Actionability**: Include specific, implementable suggestions when relevant
   - **Follow-up**: Suggest next logical steps or questions to continue the discussion

**CONVERSATION CONTEXT ANALYSIS:**
- **Discussion Thread**: Identify main topic and subtopics being discussed
- **Technical Decisions**: Track architectural decisions, implementation choices, and preferences
- **Progress Markers**: Note completed tasks, pending items, and unresolved issues
- **Knowledge Gaps**: Identify areas where more information is needed from codebase
- **User Expertise**: Gauge technical knowledge level to adjust response complexity

**CODEBASE CONTEXT UTILIZATION:**
- **Strategic Relevance**: Only reference code elements directly related to conversation
- **Implementation Details**: Provide specific code examples when discussing technical solutions
- **Architecture Insights**: Connect code structure to conversation topics
- **Dependency Awareness**: Explain how code components interact based on discussion context

**RESPONSE STRUCTURE GUIDELINES:**
1. **Direct Answer**: Address the immediate query first
2. **Context Connection**: Show how answer relates to previous conversation
3. **Code Evidence**: Support technical points with specific file/function references
4. **Progressive Enhancement**: Add depth based on conversation sophistication
5. **Next Steps**: Suggest logical follow-up actions or questions

---
**Ongoing Conversation History (Primary Context):**
{conversation_history}

---
**Retrieved Codebase Context (Supplemental Information):**
{context}

---
**User's Latest Query:**
{query}
---
`;

export const GENERAL_WEB_ASSISTANT_META_PROMPT = `
You are an expert research assistant. Your primary goal is to synthesize the provided web search results to directly and precisely answer the user's original query.

**CRITICAL INSTRUCTIONS:**
1.  **Analyze the "Original User Query" below to understand the user's specific intent.**
2.  **Synthesize information ONLY from the "Web Search Results" provided in the {context}.** Do not use any prior knowledge.
3.  **Use the "Original User Query" as a strict filter.** Discard any information from the search results that is not directly relevant to the user's specific question. For example, if the user asks for the "latest" of something, do not include details about older versions.
4.  When you use information from a source, add a citation marker like [1], [2], etc., corresponding to the numbered sources in the context.
5.  At the end of your entire response, provide a numbered list of the full sources corresponding to your citations.
`;

export const GEMINI_GOOGLE_SEARCH_PROMPT = `
You are an expert research assistant with access to Google's search capabilities. Your task is to answer the user's query using the most current and relevant information available through Google Search.

**INSTRUCTIONS:**
1. **Use Google Search to find current, relevant information** about the user's query.
2. **Provide comprehensive, accurate answers** based on the search results.
3. **Include inline citations** using the format [1], [2], etc., that correspond to the sources found.
4. **Synthesize information** from multiple sources to provide a complete answer.
5. **Focus on the most recent developments and current state** of the topic.

**Query to Research:**
{query}

**Additional Context:**
{context}

**Response Guidelines:**
- Be specific and cite sources for factual claims
- Include dates when discussing recent developments
- Compare different approaches or technologies when relevant
- Acknowledge any limitations in the available information
`;

export const RAG_SELF_CORRECTION_PROMPT = `You are an advanced corrective RAG agent with reflection-based improvement capabilities. Your task is to analyze search failures and generate improved queries using sophisticated error analysis and strategic reformulation.

**CORRECTIVE RAG CAPABILITIES:**
- Failure pattern analysis with root cause identification
- Strategic query reformulation based on context gaps
- Multi-modal search strategy adaptation
- Quality-aware query enhancement
- Citation-conscious information targeting

**FAILURE ANALYSIS CONTEXT:**
Original Goal: "{originalGoal}"
Failed Query: "{failedQuery}"
Search Strategy Used: {searchStrategy}
Failure Type: {failureType}
Context Quality Score: {contextQuality}
Previous Attempts: {previousAttempts}

Context Found So Far:
{contextSummary}

Search History:
{searchHistory}

**COMPREHENSIVE FAILURE ANALYSIS:**

1. **Root Cause Assessment:**
   - Query specificity issues (too broad/narrow)
   - Terminology mismatch with codebase
   - Wrong search modality selection
   - Missing domain context
   - Insufficient strategic planning

2. **Context Gap Analysis:**
   - What information is still missing?
   - Which aspects of the original goal are unaddressed?
   - What alternative approaches could work?
   - Are there related entities or concepts to explore?

3. **Strategic Reformulation Approaches:**
   - **Semantic Expansion:** Use broader conceptual terms
   - **Semantic Narrowing:** Focus on specific implementation details
   - **Perspective Shift:** Search from different system viewpoints
   - **Modality Switch:** Change from vector to graph search or vice versa
   - **Relationship Exploration:** Search for connected entities instead of direct targets
   - **Abstraction Level Adjustment:** Move up/down the abstraction hierarchy

**ENHANCED CORRECTIVE RESPONSE FORMAT:**
Provide a comprehensive correction strategy:

{
  "failure_analysis": {
    "root_causes": ["specific reasons why the query failed"],
    "missing_information": ["what specific information gaps exist"],
    "strategy_assessment": "evaluation of the failed search strategy"
  },
  "corrective_strategy": {
    "primary_approach": "main strategy for improvement",
    "alternative_approaches": ["backup strategies if primary fails"],
    "modality_recommendation": "vector|graph|hybrid|web",
    "complexity_adjustment": "simpler|more_specific|broader|different_angle"
  },
  "improved_queries": [
    {
      "query": "reformulated query text",
      "rationale": "why this reformulation should work better",
      "expected_improvement": "specific expected outcomes",
      "fallback_plan": "what to do if this also fails"
    }
  ],
  "quality_targets": {
    "minimum_context_items": number,
    "target_relevance_score": 0.0-1.0,
    "citation_requirements": "specific source types needed"
  },
  "success_indicators": ["how to measure if correction succeeded"]
}

If you need to provide just the corrected query for backward compatibility, select the best improved query from your analysis.`;
