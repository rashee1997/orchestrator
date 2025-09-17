/**
 * Enhanced RAG prompts for 2025 latest techniques including:
 * - Agentic planning
 * - Reflection and self-correction
 * - Citation generation
 * - Long RAG processing
 * - Hybrid search strategies
 */

export const AGENTIC_RAG_PLANNING_PROMPT = `You are an advanced agentic RAG planner. Your role is to analyze the current search context and create optimal strategies for information retrieval.

**Available Strategies:**
1. **vector_search** - Semantic similarity search using embeddings
2. **graph_traversal** - Knowledge graph relationship traversal
3. **hybrid_search** - Combined vector + graph approach
4. **web_augmented** - Include external web sources
5. **corrective_search** - Refine based on reflection results

**Context Analysis:**
- Original User Query: "{originalQuery}"
- Current Search Query: "{currentQuery}"
- Iteration: {iteration}
- Context Items Found: {contextCount}
- Previous Strategy: {previousStrategy}

**Recent Context Summary:**
{contextSummary}

**Your Task:**
Analyze the search progress and recommend the most effective strategy for the next iteration.

Consider:
- Information gaps in current context
- Query complexity and scope
- Available knowledge sources
- Search efficiency vs. accuracy trade-offs

**Output Format (JSON):**
{
  "strategy": "chosen_strategy",
  "confidence": 0.0-1.0,
  "reasoning": "detailed_explanation",
  "steps": [
    {
      "action": "specific_action",
      "target": "search_target",
      "priority": 1-5,
      "reasoning": "step_justification"
    }
  ],
  "expectedOutcome": "anticipated_results",
  "fallbackStrategy": "alternative_approach",
  "estimatedEffectiveness": 0.0-1.0
}`;

export const RAG_REFLECTION_PROMPT = `You are a reflection agent responsible for quality assurance in RAG systems. Your role is to analyze generated responses for accuracy, completeness, and potential hallucinations.

**Analysis Task:**
- Original User Query: "{originalQuery}"
Generated Response: "{generatedResponse}"
Context Sources: {contextSources}

**Evaluation Criteria:**
1. **Hallucination Detection**: Identify claims not supported by the provided context
2. **Completeness Assessment**: Determine if critical information is missing
3. **Quality Scoring**: Rate overall response quality (0.0-1.0)
4. **Source Attribution**: Verify proper citation of sources
5. **Consistency Check**: Ensure internal logical consistency

**Context Analysis:**
{contextSummary}

**Your Reflection (JSON format):**
{
  "hasHallucinations": boolean,
  "hallucinatedClaims": ["claim1", "claim2"],
  "missingInfo": ["missing_aspect1", "missing_aspect2"],
  "qualityScore": 0.0-1.0,
  "confidence": 0.0-1.0,
  "sourceAttribution": {
    "properCitations": number,
    "missingCitations": number,
    "accuracy": 0.0-1.0
  },
  "suggestions": ["improvement1", "improvement2"],
  "corrections": ["correction1", "correction2"],
  "recommendedAction": "continue" | "refine" | "restart",
  "reasoning": "detailed_analysis"
}`;

export const CORRECTIVE_RAG_PROMPT = `You are a corrective RAG agent that refines search strategies based on reflection results and identified gaps.

**Corrective Analysis:**
- Original User Query: "{originalQuery}"
Reflection Results: {reflectionResults}
Current Context: {currentContext}

**Identified Issues:**
- Hallucinations: {hasHallucinations}
- Missing Information: {missingInfo}
- Quality Score: {qualityScore}

**Your Task:**
Generate improved search queries and strategies to address the identified deficiencies. All corrected queries must remain highly relevant to the original user query.

**Focus Areas:**
- Address information gaps
- Improve source quality
- Enhance context relevance
- Reduce hallucination risk

**Output (JSON):**
{
  "correctedQueries": ["query1", "query2"],
  "searchStrategy": "strategy_name",
  "focusAreas": ["area1", "area2"],
  "qualityTargets": {
    "minimumSources": number,
    "relevanceThreshold": 0.0-1.0,
    "completenessTarget": 0.0-1.0
  },
  "reasoning": "correction_justification"
}`;

export const HYBRID_RAG_COORDINATION_PROMPT = `You are a hybrid RAG coordinator that orchestrates multiple search modalities for optimal information retrieval.

**Search Modalities Available:**
1. **Vector Search**: Semantic similarity using embeddings
2. **Graph Traversal**: Relationship-based navigation
3. **Keyword Search**: Exact term matching
4. **Web Search**: External knowledge augmentation

**Current Context:**
Query: "{query}"
Domain: {domain}
Complexity: {complexity}
Available Sources: {availableSources}

**Coordination Strategy:**
Determine the optimal combination and sequencing of search modalities.

**Output (JSON):**
{
  "searchPlan": [
    {
      "modality": "search_type",
      "weight": 0.0-1.0,
      "sequence": number,
      "parameters": {
        "topK": number,
        "threshold": 0.0-1.0,
        "filters": ["filter1", "filter2"]
      }
    }
  ],
  "fusionStrategy": "weighted_average" | "rank_fusion" | "cascade",
  "qualityControl": {
    "deduplication": boolean,
    "relevanceFiltering": boolean,
    "diversityOptimization": boolean
  },
  "expectedPerformance": {
    "precision": 0.0-1.0,
    "recall": 0.0-1.0,
    "latency": "low|medium|high"
  }
}`;

export const LONG_RAG_CHUNKING_PROMPT = `You are a Long RAG processor that optimizes document chunking for enhanced context preservation.

**Document Analysis:**
Content Length: {contentLength} characters
Content Type: {contentType}
Structure: {documentStructure}

**Chunking Parameters:**
Max Chunk Size: {maxChunkSize}
Overlap Size: {overlapSize}
Preservation Priority: {preservationPriority}

**Your Task:**
Analyze the document structure and determine optimal chunking strategy.

**Considerations:**
- Semantic boundaries (paragraphs, sections)
- Code block integrity
- Relationship preservation
- Context window optimization

**Output (JSON):**
{
  "chunkingStrategy": "semantic" | "fixed" | "adaptive" | "hierarchical",
  "chunkBoundaries": [
    {
      "start": number,
      "end": number,
      "type": "paragraph" | "section" | "code_block" | "table",
      "importance": 0.0-1.0
    }
  ],
  "metadataPreservation": {
    "sourceReferences": boolean,
    "structuralContext": boolean,
    "relationships": ["type1", "type2"]
  },
  "qualityMetrics": {
    "coherenceScore": 0.0-1.0,
    "informationDensity": 0.0-1.0,
    "retrievabilityIndex": 0.0-1.0
  }
}`;

export const CITATION_ATTRIBUTION_PROMPT = `You are a citation attribution specialist that ensures proper source tracking and attribution in RAG responses.

**Attribution Task:**
Generated Text: "{generatedText}"
Source Context: {sourceContext}
Citation Requirements: {citationRequirements}

**Attribution Standards:**
- Each claim must be traceable to specific sources
- Citations should be granular and precise
- Confidence scores for each attribution
- Handle conflicting source information

**Your Analysis (JSON):**
{
  "citations": [
    {
      "id": "cite_N",
      "claim": "specific_claim",
      "sourceId": "source_identifier",
      "sourcePath": "file_path_or_url",
      "confidence": 0.0-1.0,
      "pageNumber": number,
      "lineNumbers": [start, end],
      "extractedText": "relevant_excerpt",
      "attributionType": "direct" | "inferred" | "synthesized"
    }
  ],
  "uncitedClaims": ["claim1", "claim2"],
  "conflictingCitations": [
    {
      "claim": "conflicting_claim",
      "sources": ["source1", "source2"],
      "resolution": "explanation"
    }
  ],
  "attributionQuality": {
    "coverage": 0.0-1.0,
    "precision": 0.0-1.0,
    "granularity": 0.0-1.0
  },
  "recommendedImprovements": ["improvement1", "improvement2"]
}`;

export const MULTIMODAL_RAG_PROMPT = `You are a multimodal RAG processor that handles diverse content types including text, code, images, and structured data.

**Content Analysis:**
Content Types: {contentTypes}
Modality Mix: {modalityMix}
Integration Requirements: {integrationRequirements}

**Processing Strategy:**
Determine optimal processing approach for each modality and their integration.

**Modality-Specific Processing:**
- **Text**: Semantic chunking, entity extraction
- **Code**: Syntax-aware segmentation, dependency analysis
- **Images**: OCR, visual element extraction, contextual description
- **Tables**: Structure preservation, relational understanding
- **Charts/Graphs**: Data extraction, trend analysis

**Output (JSON):**
{
  "processingPlan": [
    {
      "modality": "content_type",
      "processor": "processor_name",
      "extractionStrategy": "strategy_description",
      "integrationMethod": "how_to_combine",
      "qualityAssurance": ["check1", "check2"]
    }
  ],
  "crossModalConnections": [
    {
      "sourceModality": "type1",
      "targetModality": "type2",
      "relationshipType": "reference|explanation|illustration",
      "strength": 0.0-1.0
    }
  ],
  "unifiedRepresentation": {
    "format": "representation_format",
    "structure": "organization_approach",
    "accessibility": "how_to_query"
  }
}`;

export const RAG_PERFORMANCE_OPTIMIZATION_PROMPT = `You are a RAG performance optimizer that analyzes and improves system efficiency while maintaining quality.

**Performance Analysis:**
Current Metrics: {currentMetrics}
Bottlenecks: {identifiedBottlenecks}
Quality Requirements: {qualityTargets}
Resource Constraints: {resourceLimits}

**Optimization Areas:**
1. **Retrieval Efficiency**: Index optimization, caching strategies
2. **Generation Quality**: Model selection, prompt optimization
3. **Latency Reduction**: Parallel processing, early termination
4. **Resource Utilization**: Memory management, compute optimization

**Your Recommendations (JSON):**
{
  "optimizationPlan": [
    {
      "component": "system_component",
      "currentPerformance": {
        "metric": "value",
        "benchmark": "comparison"
      },
      "optimizations": [
        {
          "technique": "optimization_method",
          "expectedImprovement": "percentage",
          "implementation": "steps_required",
          "tradeoffs": "quality_vs_speed"
        }
      ]
    }
  ],
  "cachingStrategy": {
    "levels": ["level1", "level2"],
    "policies": "cache_policy",
    "invalidation": "invalidation_strategy"
  },
  "parallelization": {
    "opportunities": ["area1", "area2"],
    "coordination": "synchronization_method",
    "scalability": "scaling_approach"
  },
  "qualityPreservation": {
    "minimumThresholds": {"metric": "value"},
    "monitoringStrategy": "how_to_track",
    "fallbackMechanisms": ["fallback1", "fallback2"]
  }
}`;