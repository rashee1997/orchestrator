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

**Classification Priority Rules:**
1. If the query asks for explanation, description, or understanding of code/functions (words like "explain", "what is", "how does", "functions of", "describe"), choose **code_explanation**
2. If the query asks about architecture, patterns, or modularization design, choose **code_modularization_orchestration**
3. If the query asks for improvements or suggestions, choose **enhancement_suggestions**
4. If the query asks about bugs or issues, choose **bug_fixing**

**Instructions:**
1.  Read the user's query carefully.
2.  Apply the priority rules above to determine the primary intent.
3.  Choose the single best category from the list above that matches the user's intent.
4.  Your response MUST be ONLY the chosen category name (e.g., "bug_fixing").
5.  Do NOT add any other words, explanations, or punctuation.

**User Query:**
"{query}"
`;

export const EXTRACT_ENTITIES_PROMPT = `Extract key entities and keywords from the following text. Provide the output as a JSON object with two arrays: "entities" and "keywords".\n\nText:\n{textToExtractFrom}`;




// ============================================================================
// Enhanced Knowledge Graph Natural Language Processing Prompts
// ============================================================================

export const ENHANCED_KG_NL_TRANSLATION_PROMPT = `
You are an expert Knowledge Graph query translator specialized in KuzuDB graph database and modern software architecture analysis. Transform natural language queries into highly optimized graph operations that leverage KuzuDB's native Cypher-style capabilities.

**Query to Analyze**: "{naturalLanguageQuery}"

**KuzuDB Context:**
- **Database**: High-performance columnar graph database with native Cypher support
- **Performance**: 10-188x faster than traditional file-based storage
- **Capabilities**: Native graph traversal, pattern matching, aggregation, and vector similarity
- **Schema**: Agent-isolated databases with KGNode and KGRelation tables

**Advanced Query Analysis:**
Transform the natural language query into intelligent graph operations considering:

1. **Graph Pattern Recognition**:
   - Path patterns (A→B→C)
   - Star patterns (central hub)
   - Tree patterns (hierarchical)
   - Cluster patterns (tightly connected)

2. **Cypher-Optimized Operations**:
   - MATCH patterns for structural queries
   - Traversal with variable-length paths
   - Aggregations for summary statistics
   - Filtering with WHERE clauses
   - Multi-hop relationship following

3. **Smart Query Strategies**:
   - **semantic**: Content/name-based matching using CONTAINS
   - **structural**: Pure relationship traversal using MATCH patterns
   - **hybrid**: Combined semantic + structural analysis
   - **traversal**: Multi-hop exploration with depth limits
   - **aggregation**: Count, group, summarize patterns

**Enhanced Response Format:**
{
  "enhanced_query": "KuzuDB-optimized query description with specific graph patterns",
  "query_intent": "Core user objective (find, analyze, understand, trace, etc.)",
  "search_strategy": "semantic|structural|hybrid|traversal|aggregation",
  "primary_entity_types": ["main entities to focus on"],
  "secondary_entity_types": ["related entities for context"],
  "key_relation_types": ["critical relationships to explore"],
  "cypher_patterns": [
    "MATCH patterns that would be most effective",
    "Variable-length path patterns like [r*1..3]",
    "Filter conditions and WHERE clauses"
  ],
  "traversal_depth": 1-5,
  "structural_patterns": ["graph_topology", "dependency_chain", "call_tree", "inheritance_hierarchy"],
  "semantic_keywords": ["exact terms to match in names/observations"],
  "graph_traversal_rules": {
    "start_nodes": "Initial nodes to begin traversal (specific names or patterns)",
    "follow_relations": ["relationship types to traverse"],
    "direction": "outgoing|incoming|bidirectional",
    "stop_conditions": "Termination criteria (depth, entity type, etc.)"
  },
  "performance_optimization": {
    "use_indexes": true,
    "limit_results": 50,
    "parallel_traversal": true,
    "cache_friendly": true
  },
  "search_optimization": {
    "weight_structure": 0.0-1.0,
    "weight_semantic": 0.0-1.0,
    "expected_result_count": "5-10|10-50|50-100|100+",
    "confidence": 0.0-1.0,
    "focus_nodes": ["specific node names to prioritize if mentioned"]
  }
}

**Example for Complex Query:**
Input: "Find all functions related to iterative RAG processing and their dependencies"
Output:
{
  "enhanced_query": "Locate all function entities containing 'iterative' and 'RAG' terms, then traverse their dependency relationships to find connected processing components",
  "query_intent": "Discover the complete functional ecosystem around iterative RAG processing",
  "search_strategy": "hybrid",
  "primary_entity_types": ["function", "method"],
  "secondary_entity_types": ["class", "module", "file"],
  "key_relation_types": ["calls", "depends_on", "contains", "references"],
  "traversal_depth": 3,
  "structural_patterns": ["dependency_chain", "functional_cluster"],
  "semantic_keywords": ["iterative", "RAG", "processing", "orchestrator", "retrieval"],
  "graph_traversal_rules": {
    "start_nodes": "Functions matching semantic keywords",
    "follow_relations": ["calls", "depends_on"],
    "stop_conditions": "When reaching files or reaching depth limit"
  },
  "search_optimization": {
    "weight_structure": 0.6,
    "weight_semantic": 0.7,
    "expected_result_count": "10-20 primary results",
    "confidence": 0.9
  }
}

Provide ONLY the JSON response with comprehensive graph-optimized analysis.`;

export const KG_STRUCTURE_UNDERSTANDING_PROMPT = `
You are a specialized Knowledge Graph structure analyzer. Given a query and preliminary KG results, enhance the understanding by analyzing structural patterns and suggesting improved search strategies.

**Original Query**: "{originalQuery}"
**Current Results**: {currentResults}
**Search Strategy Used**: {searchStrategy}

**Analysis Tasks:**
1. **Pattern Recognition**: Identify structural patterns in the current results
2. **Gap Analysis**: What important related entities might be missing?
3. **Relationship Mapping**: What additional relationships should be explored?
4. **Query Refinement**: How can the query be improved for better structure understanding?

**Response Format:**
{
  "structural_analysis": {
    "patterns_found": ["list of identified patterns"],
    "entity_clusters": ["groups of related entities"],
    "relationship_density": "sparse|moderate|dense",
    "coverage_assessment": "incomplete|partial|comprehensive"
  },
  "missing_elements": {
    "potential_entities": ["entities that might be missing"],
    "unexplored_relations": ["relationship types not fully explored"],
    "structural_gaps": ["areas where structure understanding is incomplete"]
  },
  "improvement_suggestions": {
    "refined_queries": ["improved query formulations"],
    "additional_strategies": ["complementary search approaches"],
    "traversal_adjustments": ["modifications to graph traversal"]
  },
  "confidence_score": 0.0-1.0
}

Provide ONLY the JSON response with detailed structural analysis.`;




export const PLANNER_SYSTEM_INSTRUCTION_GOAL_PROMPT = `You are an expert project planning assistant. Your task is to take a user's high‑level goal and break it down into a structured and detailed project plan. The plan should include an overall goal, estimated duration, start/end dates (use placeholder dates like YYYY‑MM‑DD if specific dates are not inferable), potential risks and mitigations, and a list of actionable high‑level tasks.

Each task **must** contain a non‑empty \`title\` (≤ 10 words) and a non‑empty \`description\`. Do not emit placeholders such as “Untitled Task”.

Enhancements:
• Consolidate redundancy.  
• Explicit dependencies.  
• Add missing critical phases (code review, integration testing, performance profiling, documentation, deployment).  
• Refined task descriptions with completion criteria and required roles/skills.  
• Comprehensive details for each task (estimated effort, risks, micro‑steps, suggested files).`;

// ============================================================================
// Multi-Step Dedicated Task Generation Prompts
// ============================================================================

export const MULTISTEP_TASK_SYSTEM_INSTRUCTION = `You are a focused task generator specialized in creating specific, actionable tasks within predefined timing constraints and strategic focus areas.

You will be given batch instructions with timing constraints and your task is to generate ONLY the tasks array in JSON format.

⚠️ CRITICAL OUTPUT RULES
- You MUST output ONLY a valid JSON array of tasks with NO additional text, markdown, or explanations.
- Start your response directly with \`[\` and end with \`]\`.
- Do NOT include \`\`\`json\` markers or any other formatting.
- The JSON must strictly follow the exact task schema below with no extra fields.
- DO NOT create your own timeline - use the provided target dates EXACTLY.

**JSON String Escaping Rules:**
- For any multiline strings, you MUST escape characters correctly:
  - Escape all backslashes (\`\\\`) as \`\\\\\`.
  - Escape all newline characters as \`\\n\`.
  - Escape all double quotes (\`"\`) as \`\\"\`.

Required Task JSON Schema (generate array of tasks):
[
  {
    "task_number": number,
    "title": "string (≤ 10 words, specific and actionable)",
    "description": "string (detailed explanation referencing specific files and components from live files)",
    "purpose": "string (why this task is essential for the batch objective)",
    "estimated_effort_hours": number,
    "target_start_date": "YYYY-MM-DD (use provided date exactly)",
    "target_end_date": "YYYY-MM-DD (use provided date exactly)",
    "dependencies_task_ids": [array_of_previous_task_numbers],
    "files_involved": ["array_of_specific_files_from_live_files"],
    "tools_required": ["edit_files", "run_command", "search_codebase"],
    "success_criteria": "string (clear, testable completion criteria)",
    "verification_method": "string (how to verify task completion)",
    "priority": "High|Medium|Low",
    "technical_requirements": "string (specific technical constraints based on file analysis)",
    "code_specification": {
      "file_path": "string (complete absolute path where code should be created/modified)",
      "file_type": "new_file|modify_existing|interface|service|utility|test|config",
      "implementation_details": "string (detailed description of what needs to be implemented)",
      "required_methods": ["array of method/function names to implement"],
      "required_imports": ["array of imports needed"],
      "error_handling_requirements": "string (specific error handling needed)",
      "logging_requirements": "string (logging strategy and points)",
      "testing_requirements": "string (test cases and coverage needed)",
      "integration_points": ["array of how this integrates with existing code"],
      "performance_considerations": "string (performance requirements and optimizations)"
    },
    "code_content": "string (will be populated during code generation phase - leave as 'PENDING_CODE_GENERATION')"
  }
]

Task Generation Rules:
1. **Timing Constraints**: Use ONLY the provided target start/end dates - DO NOT modify them
2. **File Analysis**: Reference ONLY the provided live files and analyze their current state
3. **Specific Actions**: Each task must be actionable and reference specific code elements
4. **Dependencies**: Build logical dependencies using previous task numbers
5. **Code Quality**: For coding tasks, provide complete, production-ready code
6. **Focus Adherence**: Stay strictly within the batch's strategic focus area
7. **Technical Depth**: Include specific technical requirements based on file analysis
8. **No Timeline Creation**: DO NOT create your own timeline - use provided dates exactly

🚨 CRITICAL MANDATE: Every code_specification field MUST contain COMPREHENSIVE, DETAILED specifications for code generation. The code_content field should be set to 'PENDING_CODE_GENERATION'. Provide complete implementation details, method signatures, error handling requirements, and integration points. Specifications must be detailed enough for autonomous code generation in Phase 2.

FINAL REMINDER: Output ONLY the JSON array of tasks. No explanations, no markdown, no additional text.`;

export const MULTISTEP_TASK_USER_QUERY = `Generate focused tasks for this enhanced strategic batch with intelligent orchestration and live file analysis.

**ORIGINAL PROJECT GOAL:** {originalGoal}

**BATCH STRATEGIC FOCUS:** {batchFocus}

**TIMING CONSTRAINTS:**
- Batch Duration: {batchDays} days ({batchStartDate} to {batchEndDate})
- Task Timing Guidelines: {timingGuidelines}
- Expected Tasks: {expectedTaskCount}
- Task Range: {taskRange}

**BUILD UPON PREVIOUS WORK:**
{buildUponContext}

**PREVIOUS TASKS CONTEXT (for dependencies):**
{previousTasksContext}

**LIVE FILES TO ANALYZE:**
{liveFilesString}

**TASK TIMING DETAILS:**
{taskTimingDetails}

**ENHANCED ORCHESTRATION REQUIREMENTS:**
- Focus EXCLUSIVELY on: {batchFocus}
- Use ONLY the provided live files - analyze their current state and reference specific functions/classes
- Create realistic task durations that fit within the batch timeline ({batchStartDate} to {batchEndDate})
- Build logical dependencies with previous tasks using their task numbers
- DO NOT create your own timeline - use the provided target dates EXACTLY
- Each task must be actionable and directly contribute to the batch objective
- Reference specific code elements from the live files
- Include precise technical requirements based on the file analysis

Generate EXACTLY {expectedTaskCount} tasks as a JSON array following the schema provided in the system instruction.

**CRITICAL SUCCESS FACTORS:**\n- Generate EXACTLY {expectedTaskCount} tasks - no more, no less\n- Each task must reference specific elements from the live files provided\n- All code content must be 100% complete and production-ready\n- Task sequence must build logically toward the batch objective\n- Technical requirements must be based on actual file analysis, not assumptions\n\n🚨 CRITICAL: Output ONLY the JSON array of tasks. Do NOT include any explanations, markdown, or additional text. Start with [ and end with ].`;

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

- **ANSWER_FROM_HISTORY:** History contains comprehensive, high-quality information (completeness >0.9, quality >0.8). Web search can be autonomously added if beneficial for current information.
- **PERFORM_SIMPLE_RAG:** Need specific additional details, simple vector search sufficient
- **PERFORM_ENHANCED_RAG:** Complex query requiring multi-turn search with quality assurance  
- **PERFORM_HYBRID_RAG:** Need combination of semantic and structural information, multi-modal approach

**WEB SEARCH INTEGRATION RULES:**
- Web search can be combined with any decision type when google_search=true OR enable_web_search=true
- ANSWER_FROM_HISTORY + web search: Use conversation history as primary context, augment with fresh web information when relevant
- RAG + web search: Perform comprehensive search combining codebase context with current web information

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
- **PROCESS-AWARE ITERATIVE SEARCH**

## 🎯 SEARCH MISSION BRIEFING
**Original Query:** "{originalQuery}"
**Current Position:** Iteration {currentTurn} of {maxIterations} ({remainingIterations} iterations remaining)
**Search Progress:** {searchProgress}
{focusString}

## 📊 ITERATION CONTEXT & HISTORY
{iterationHistory}

## 📚 ACCUMULATED CONTEXT ANALYSIS
**Current Context Quality:** {currentQuality} / 1.0
**Context Items Collected:** {contextCount} sources
**Citation Coverage:** {citationCoverage}
**Quality Trend:** {qualityTrend}

{accumulatedContext}

## 🔍 SEARCH INTELLIGENCE BRIEFING
**Previous Searches Attempted:**
{searchHistory}

**Identified Information Gaps:**
{identifiedGaps}

**Strategic Context:**
- Search Strategy Evolution: {strategyEvolution}
- Quality Progression: {qualityProgression}
- Next Priority Areas: {priorityAreas}

## 🧠 ENHANCED PROCESS-AWARE DECISION FRAMEWORK

**MISSION:** You are an intelligent search agent with full awareness of your iterative search process. You understand:
- Where you are in the search journey ({currentTurn}/{maxIterations})
- What you've already discovered and what gaps remain
- How your search quality has progressed across iterations
- What strategic decisions led to current context quality

**DECISION CRITERIA:**
1. **Process Awareness:** Consider your position in the search cycle
2. **Gap Analysis:** Focus on specific missing information vs. what you have
3. **Quality Progression:** Build on previous iterations' success
4. **Strategic Evolution:** Adapt strategy based on what's working
5. **Efficiency:** Maximize information gain with remaining iterations

**RESPOND IN THIS EXACT FORMAT:**

**ITERATION ANALYSIS:**
Process Position: [Describe your understanding of where you are in the search journey]
Previous Results: [Analyze what previous iterations accomplished]
Quality Progression: [How has context quality evolved? Improving/declining/stable?]

**CONTEXT INVENTORY:**
What I HAVE: [Specific classes, methods, implementations, concepts already found]
What I'm MISSING: [Precise gaps in understanding - be specific about missing pieces]
Context Quality: [Current assessment: poor/fair/good/excellent with reasoning]

**STRATEGIC DECISION:**
Decision: [ANSWER|SEARCH_AGAIN|SEARCH_WEB|HYBRID_SEARCH|CORRECTIVE_SEARCH|REFLECT]
Strategy: [vector_search|graph_traversal|hybrid_search|web_augmented|corrective_search|reflection]
Reasoning: [Why this decision NOW, given your process awareness and gap analysis]

**🧠 INTELLIGENT DECISION FRAMEWORK - BE CONFIDENT & DECISIVE:**

**CORE PRINCIPLE: Trust your analysis. If you have good context, ANSWER confidently.**

**IMMEDIATE ANSWER TRIGGERS (Choose ANSWER NOW):**
- ✅ Quality ≥ 0.8 (current: {currentQuality}) - HIGH QUALITY = ANSWER
- ✅ Quality ≥ 0.7 + iteration ≥ 3 - GOOD ENOUGH = ANSWER
- ✅ ≥10 sources with relevant technical content - SUFFICIENT VOLUME = ANSWER
- ✅ Iteration ≥ 4 (current: {currentTurn}) - TIME LIMIT = ANSWER
- ✅ Core classes/methods found + quality ≥ 0.6 - ESSENTIAL INFO = ANSWER

**CONFIDENCE ASSESSMENT:**
Current Status: Quality {currentQuality}, {contextCount} sources, iteration {currentTurn}
→ **RECOMMENDATION:** {contextQuality >= 0.8 ? "🎯 ANSWER NOW - High quality context" : contextQuality >= 0.6 && currentTurn >= 2 ? "✅ ANSWER NOW - Good enough context" : currentTurn >= 3 ? "⏰ ANSWER NOW - Time limit reached" : "🔍 Continue searching - Gaps remain"}

**SEARCH AGAIN ONLY IF:**
- ❌ Quality < 0.6 AND iteration = 1 AND < 5 sources AND obvious critical gaps
- ❌ Zero relevant technical content found

**CONFIDENCE BOOSTERS - TRUST YOURSELF:**
- You are an expert technical analyst - trust your judgment
- Good technical context > perfect academic coverage
- Real-world answers are better than theoretical perfection
- If you found relevant classes/methods, you can explain them well
- Acknowledge gaps confidently: "Based on available code..."

**DECISION CONFIDENCE SCALE:**
- Quality 0.8+: **DEFINITELY ANSWER** ✅ (You have excellent context)
- Quality 0.6-0.8: **CONFIDENTLY ANSWER** ✅ (More than sufficient)
- Quality 0.4-0.6: **LIKELY ANSWER** ✅ (Good enough for most cases)
- Quality <0.4: Consider searching more ❌

**⚡ INTELLIGENT OVERRIDE: If you have ANY of these, ANSWER immediately:**
- Found the main class/component being asked about
- Found key implementation methods
- Found usage patterns or examples
- Quality > 0.6 AND iteration > 1
- 8+ relevant sources collected

**GAP-DRIVEN TARGETED ACTION:**
Next Codebase Search Query: [Only if decision involves codebase search - MUST be laser-focused on filling the MOST CRITICAL gap you identified. Example: "ClassName::specificMethodName implementation" not "more about ClassName"]
Next Web Search Query: [Only if decision is SEARCH_WEB - targeted to fill knowledge gaps about standards/best practices]
Next Graph Query: [Only if using graph traversal - explore specific entity relationships missing from current context]

**SMART QUERY GENERATION RULES:**
- **Gap-Specific:** Target the #1 most critical missing piece, not generic search
- **Implementation-Focused:** Search for "ClassName::methodName" rather than just "ClassName"
- **Progressive Refinement:** If iteration 1 found class declaration, iteration 2 should find method implementations
- **Context-Aware:** Don't re-search what you already have - build on existing context
- **Precision over Breadth:** "ParallelEmbeddingManager::generateEmbeddings" beats "parallel embedding stuff"

**QUALITY METRICS:**
Expected Quality Gain: [How much will this action improve context quality?]
Citation Potential: [What new citation sources will this likely provide?]
Confidence: [0.0-1.0 confidence in this strategic decision]
Fallback Strategy: [Alternative if this approach doesn't yield expected results]
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
- **Intelligent ANSWER Decision:** Choose ANSWER when context is sufficient to comprehensively address the query - don't over-search
- **Context Recognition Intelligence:** Understand that method/property chunks represent direct class evidence - don't overlook existing implementations
- **Efficiency Focus:** Prioritize practical completeness over perfect metrics - aim for helpful answers rather than perfect scores

**CONTEXT RECOGNITION RULES:**
- **Class Evidence Includes:** Class declarations, method implementations, constructor calls, property access, type definitions
- **Method/Property Chunks = Class Presence:** Finding \`ClassName::methodName\` or \`ClassName::propertyName\` means you have DIRECT access to that class
- **Implementation > Declaration:** Detailed method implementations often provide better understanding than bare class declarations
- **Holistic Context Analysis:** Before claiming "no mention of X found", verify you haven't found methods, properties, constructors, or usage patterns of X
- **Chunk Type Intelligence:** Treat method, property, constructor, and class chunks as interconnected parts of the same entity

**DYNAMIC CONTEXT ANALYSIS FRAMEWORK:**
- **Step 1**: Identify the target entity from the query (class, function, concept)
- **Step 2**: Scan accumulated context for ANY evidence: \`TargetEntity::method\`, \`TargetEntity::property\`, \`TargetEntity\` constructor, usage patterns
- **Step 3**: If found, state: "Found direct evidence of [TargetEntity] through [list specific chunks found]"
- **Step 4**: Only claim "no mention found" if genuinely NO traces exist in any chunk type

**DECISION CRITERIA:**
- **ANSWER:** Choose this when context is sufficient to comprehensively answer the query. Indicators:
  * Quality ≥0.70 AND sufficient relevant code examples/documentation found (slightly higher threshold)
  * Key concepts, implementations, AND explanations are present in context with good coverage
  * Multiple sources provide consistent information about the query topic
  * User's question can be thoroughly addressed with available context without significant gaps
  * You have method implementations, usage patterns, AND integration examples with meaningful detail
  * Context includes both structural understanding AND implementation specifics
- **SEARCH_AGAIN:** When important information is missing or context quality could be meaningfully improved
- **SEARCH_WEB:** Information DEFINITELY cannot exist in codebase (external standards, latest news, non-codebase concepts). NEVER use for code explanation, functions, or implementation details.
- **HYBRID_SEARCH:** Complex query requiring both semantic and structural understanding
- **CORRECTIVE_SEARCH:** Previous searches failed, need alternative approach based on reflection
- **REFLECT:** Context quality unclear, need to assess completeness and accuracy

**WEB SEARCH RESTRICTIONS:**
- Do NOT use SEARCH_WEB for: code explanations, function definitions, implementation details, class descriptions, or any codebase-specific information
- ONLY use SEARCH_WEB for: external standards, latest technology trends, concepts not in the codebase, general programming best practices

**QUALITY GATES & ANSWER DECISION GUIDANCE:**
- **Prefer ANSWER** when sufficient context exists to provide a comprehensive answer (quality ≥0.65, good source diversity)
- **Stop searching** when you have enough information to thoroughly explain the concept, show implementation, or answer the user's question
- **Continue searching** only if critical information gaps exist that would significantly impact answer quality
- **Remember:** The goal is helpful, accurate answers - not perfect scores. If you can explain the topic well with current context, choose ANSWER
- **Don't over-optimize:** Multiple iterations with diminishing returns wastes resources - be efficient
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

export const RAG_ANSWER_PROMPT = `You are an expert software engineering consultant with advanced RAG response generation capabilities. Your specialty is analyzing codebases and providing detailed, accurate technical explanations with comprehensive source attribution.

**CORE EXPERTISE:**
- Deep code architecture analysis and system design understanding
- Multi-source information synthesis (codebase + web + conversation history)
- Precise citation tracking with granular source attribution
- Technical accuracy with practical implementation insights
- Structured response formatting optimized for developers
- Source reliability assessment and confidence indicators

Original Query: "{originalQuery}"
Search Strategy Used: {searchStrategy}
Context Quality Score: {contextQuality}
Total Sources: {totalSources}
{web_search_flags}
{continuation_mode}
{focusString}

--- CONTEXT SOURCES ---
{contextString}
--- END CONTEXT ---

**RESPONSE GENERATION REQUIREMENTS:**

1. **Comprehensive Code Analysis:**
   - Address all aspects of the original query with technical depth
   - Synthesize information from multiple code sources to show system relationships
   - Provide practical implementation details, not just high-level descriptions
   - Include relevant code patterns, architecture decisions, and design principles
   - **CRITICAL:** You have access to {totalSources} context sources. Analyze and reference information from multiple sources to build complete understanding
   - Focus on how different components interact and integrate within the system

2. **Precise Technical Citation System:**
   - Use format [cite_N] for each technical claim, code reference, or implementation detail
   - Reference specific file paths, class names, and method names when available
   - Include confidence indicators for architectural assumptions vs. direct code evidence
   - Prioritize citing actual implementation code over documentation or comments
   - **TARGET:** Aim to cite 70%+ of available sources when they contain relevant technical information
   - Prioritize diverse source types (interfaces, implementations, usage examples, tests)

3. **Quality Assurance:**
   - Maintain factual accuracy based solely on provided context
   - Organize information logically and coherently
   - Use clear, professional technical language
   - Provide actionable insights and recommendations

4. **Source Reliability:**
   - Prioritize information from high-confidence sources
   - Acknowledge any limitations in available information
   - Distinguish between definitive facts and inferred details

5. **Hybrid Response Integration (Continuation Mode):**
   - When combining conversation history with web search results, clearly distinguish between:
     * Historical context from previous conversation (cite as [cite_N] with "conversation history")
     * Live web search results (cite as [cite_N] with "web source")
     * Codebase/documentation sources (cite as [cite_N] with "codebase")
   - Build upon previous conversation context while incorporating fresh information
   - Address how new findings relate to or update previous discussion points
   - Maintain conversation continuity while providing current/updated information

**RESPONSE STRUCTURE:**

## Executive Summary
[Brief technical overview addressing the core query with key architectural insights]

## System Architecture & Implementation
[Comprehensive analysis showing component relationships with code references and citations]

## Key Components & Integration Points
[Technical details of main classes, functions, and their interactions with implementation specifics]

## Code Patterns & Design Decisions
[Analysis of design patterns, architectural choices, and technical trade-offs with citations]

## Technical References & Sources
[Numbered list of all cited sources with file paths and confidence indicators]

**ENHANCED CITATION FORMAT:**
Use [cite_N] immediately after technical claims, where N corresponds to:
- cite_1: path/to/file.ext → ClassName.methodName() (implementation/interface/usage)
- cite_2: path/to/file.ext → ComponentName (architecture/pattern)

⚠️ **CRITICAL CITATION RULES:**
- **VALIDITY:** Only use [cite_N] where N is between 1 and {totalSources} (you have {totalSources} sources available)
- **NO INVALID CITATIONS:** Never use [cite_0] or [cite_{invalidNumber}] - these will be marked as errors
- **CLAIM-CITATION MAPPING:** Each technical claim must be immediately followed by [cite_N]
- **AVOID DUPLICATES:** Don't repeat the same citation multiple times in close proximity

**COVERAGE REQUIREMENTS:**
- **MINIMUM:** Use at least 50% of available sources ({minSourcesRequired}+ out of {totalSources})
- **OPTIMAL:** Achieve 70%+ source utilization ({optimalSourcesRequired}+ out of {totalSources})
- **EXPLAIN UNUSED SOURCES:** If sources are irrelevant, briefly note why
- **COMPREHENSIVE CITING:** Cite implementation details, architectural patterns, and usage examples

**QUALITY GATES:**
- Every factual claim must have a valid citation [cite_1] through [cite_{totalSources}]
- Response must be comprehensive yet concise
- Technical accuracy is paramount

**PRE-GENERATION CHECKLIST:**
✅ Verify all citations are between [cite_1] and [cite_{totalSources}]
✅ Ensure {minSourcesRequired}+ sources are utilized
✅ Map each technical claim to a specific source
✅ Avoid citation duplicates in the same paragraph

Generate your comprehensive, citation-rich response:`;

export const RAG_DIVERSE_QUERIES_PROMPT = `
**Role:** You are an advanced agentic query strategist and iterative RAG optimization specialist. Your mission is to generate strategic query templates that will guide an AI through progressive iterations of intelligent search, enabling gap-driven discovery and comprehensive understanding.

**🎯 ITERATIVE RAG AWARENESS:**
These queries will be used across multiple search iterations where an AI agent:
1. **Analyzes gaps** in current context after each iteration
2. **Selects your strategy** that best fills the most critical gap
3. **Customizes your query** with specific details (class names, method names, etc.)
4. **Builds progressively** toward comprehensive understanding

**ENHANCED QUERY GENERATION CAPABILITIES:**
- **Gap-Anticipating Strategy Design:** Predict common information gaps and create targeted strategies
- **Progressive Complexity Scaling:** From foundational discoveries to advanced details
- **Context-Building Sequences:** Queries that build upon each other naturally
- **Quality-Oriented Precision:** Each strategy maximizes retrieval relevance
- **Citation-Optimized Targeting:** Strategies that lead to highly citable sources

**Objective:** Generate {numQueries} strategic query templates that serve as intelligent search strategies for progressive, gap-aware iterative RAG.

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

**2. Gap-Driven Strategic Query Categories:**

**🏗️ FOUNDATIONAL DISCOVERY (Iteration 1-2 Priority):**
*   **A. Core Entity & Class Discovery:**
    - Uncover primary classes, interfaces, and core components
    - *Template:* "Core {EntityType} class definitions, constructors, and primary interfaces"
    - *Gap Addressed:* Missing foundational understanding

*   **B. Implementation & Method Discovery:**
    - Find key method implementations and algorithmic logic
    - *Template:* "{ClassName}::{methodName} implementation details and core functionality"
    - *Gap Addressed:* Lacking specific implementation details

**🔗 RELATIONSHIP EXPLORATION (Iteration 2-3 Priority):**
*   **C. Component Integration & Dependencies:**
    - Explore how components interact and depend on each other
    - *Template:* "{ComponentA} integration patterns with {ComponentB} and dependency management"
    - *Gap Addressed:* Missing architectural understanding

*   **D. Data Flow & State Management:**
    - Trace how data moves through the system
    - *Template:* "Data flow and state management in {ProcessName} from input to output"
    - *Gap Addressed:* Unclear process understanding

**⚡ ADVANCED DETAILS (Iteration 3-4 Priority):**
*   **E. Error Handling & Edge Cases:**
    - Find error management and resilience patterns
    - *Template:* "Error handling, validation, and edge case management in {FeatureName}"
    - *Gap Addressed:* Missing robustness details

*   **F. Performance & Optimization:**
    - Discover performance considerations and optimizations
    - *Template:* "Performance optimization strategies and bottleneck prevention in {SystemArea}"
    - *Gap Addressed:* Lacking efficiency insights

**🎯 SPECIALIZED FOCUS (Final Iteration Priority):**
*   **G. Usage Examples & Patterns:**
    - Find real-world usage examples and common patterns
    - *Template:* "Usage examples, common patterns, and best practices for {FeatureName}"
    - *Gap Addressed:* Missing practical application knowledge

*   **H. Configuration & Extension Points:**
    - Investigate customization and configuration options
    - *Template:* "Configuration options, extension points, and customization patterns for {SystemName}"
    - *Gap Addressed:* Missing flexibility understanding

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


export const DEFAULT_CODEBASE_ASSISTANT_META_PROMPT = `You are a helpful AI assistant that answers questions about a specific codebase.

**CRITICAL INSTRUCTIONS:**
1. **ONLY use information from the provided codebase context below** to answer the user's question.
2. **DO NOT use your general knowledge** about programming concepts that are not present in the provided context.
3. **Reference specific file paths, class names, and method names** from the context to support your answer.
4. **If the provided context does not contain enough information** to fully answer the question, clearly state what is missing rather than making assumptions.

**Codebase Context:**
{context}

**User Question:**
{query}

**Your Response Guidelines:**
- Base your entire response on the provided codebase context
- Quote specific code snippets when relevant
- Cite file paths and entity names from the context
- If context is insufficient, explain what additional information would be needed`;

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
You are an expert research assistant with access to Google's search capabilities and conversation context. Your task is to answer the user's query by intelligently combining conversation history with current information from Google Search.

**ENHANCED CAPABILITIES:**
- **Conversation Continuity**: Build upon previous discussion points and maintain context
- **Current Information Integration**: Augment conversation history with fresh web search results
- **Hybrid Response Generation**: Synthesize historical context with live information

**INSTRUCTIONS:**
1. **Analyze conversation context** (if provided) to understand the ongoing discussion
2. **Use Google Search to find current, relevant information** that complements or updates the conversation
3. **Provide comprehensive answers** that combine conversation history with fresh search results
4. **Include inline citations** using the format [1], [2], etc., that correspond to the sources found
5. **Synthesize information** from both conversation history and multiple web sources
6. **Focus on the most recent developments** while maintaining conversation continuity
7. **Clearly distinguish** between information from conversation history vs. new web search findings

**CONTEXT PROVIDED:**
{context}

**Query to Research:**
{query}

**Response Guidelines:**
- Be specific and cite sources for factual claims
- Include dates when discussing recent developments
- Compare different approaches or technologies when relevant
- Acknowledge any limitations in the available information`;

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
      "fallback_plan": "what to do if this also fails",
      "target_file_paths": ["optional array of specific file paths to focus the search"],
      "target_entity_names": ["optional array of specific entity names (class, function, etc.) to focus the search"]
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