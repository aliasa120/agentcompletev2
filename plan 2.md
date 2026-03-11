# **Product Requirements Document (PRD)**

## **AI-Powered Multi-Platform News Automation System \- LITE VERSION**

---

## **1\. Executive Summary**

## **1.1 Product Vision**

A streamlined autonomous AI agent system that aggregates news from Google News feeds, processes content through intelligent deduplication layers, and automatically generates contextually rich social media posts for Facebook, Instagram, and X (Twitter) using a simplified single-provider architecture.

## **1.2 Core Value Proposition**

* Automated News Processing: Eliminate manual news curation and content creation  
* Multi-Layer Deduplication: Ensure zero duplicate content through 7-layer filtering system  
* Snippet-First Intelligence: Use search snippets when sufficient, scrape only when needed  
* Multi-Platform Distribution: Single workflow generates optimized content for three platforms  
* Simplified Architecture: Single search API \+ single scraper API for easier setup  
* Full Autonomy: End-to-end automation from feed ingestion to draft post creation

## **1.3 Target Users**

* Individual content creators  
* Small news blogs  
* Social media managers  
* Users wanting simple setup without complex configuration

---

## **2\. System Architecture Overview**

## **2.1 High-Level Components**

text

`[Google News Feed]`   
    `↓`  
`[Feeder System - 7 Layers]`  
    `↓`  
`[Agent Queue]`  
    `↓`  
`[AI Agent - Vercel AI SDK]`  
    `├─→ [Brave Search API - 10 results with 5 snippets each]`  
    `└─→ [Exa AI Scraper - only when snippets insufficient]`  
    `↓`  
`[Draft Posts - 3 Platforms]`

## **2.2 Technology Stack**

Agent Framework:

* Vercel AI SDK (Agentic framework)

Databases:

* Supabase (primary relational database)  
* Pinecone (vector database for semantic similarity)

AI Model Provider:

* LiteLLM (single provider)  
  * moonshotai/kimi-k2-thinking  
  * moonshotai/kimi-k2-instruct-0905  
      
  * openai/gpt-oss-120b

Search API (Fixed):

* Brave Search API  
  * Returns 10 search results per query  
  * Each result includes up to 5 snippets  
  * Total: 50 snippets available per search

Scraper API (Fixed):

* Exa AI Extract API  
  * Used only when snippets insufficient  
  * Called for top 3 selected URLs maximum

---

## **3\. Feeder System**

## **3.1 Purpose**

The Feeder aggregates news from Google News feeds and filters articles through a 7-layer deduplication and quality control system.

## **3.2 Feed Configuration**

Feed Source:

* Google News RSS feeds  
* Geographic focus: Pakistan news means set feeds url on pakistan news(configurable per user)


## **3.3 Multi-Layer Filtering System**

## **Layer \-2: Time-Based Filtering**

Purpose: Filter articles by publication time  
It is settings user can configure how much old posts fetch from google news feed

Configuration Options:

* 30 minutes old  
* 1 hour old  
* 4 hours old  
* Custom time range

Logic:

text

`IF article.timestamp < (current_time - time_threshold):`  
    `DROP article`  
`ELSE:`  
    `PASS to Layer -1`

## **Layer \-1: Domain Whitelisting**

Purpose: Filter articles by trusted news sources

Whitelist Categories:

* Pakistani Sources: ARY News, Geo, Dawn, Geo Pro, Pakistani Express Tribune  
* International Sources: CNN, BBC, Al Jazeera

User Configuration:

* Users define custom whitelisted domains  
* Option to add/remove domains

Logic:

text

`IF article.domain IN whitelist:`  
    `PASS to Layer 1`  
`ELSE:`  
    `DROP article`  
**Layer 0: Event Clustering**

Purpose: Deduplicate articles covering the same event

Logic:

* Identify articles about the same event  
* Rank sources by trust/authority  
* Select best article from most trusted source  
* Drop remaining duplicate event coverage

## **Layer 1: GUID Verification**

Purpose: Prevent duplicate articles using Globally Unique Identifiers

Database: Supabase

Logic:

text

`IF article.guid EXISTS IN database:`  
    `DROP article (duplicate)`  
`ELSE:`  
    `STORE article.guid`  
    `PASS to Layer 2`

## **Layer 2: Hash Verification**

Purpose: Detect duplicates through content hashing

Database: Supabase

Hash Generation:

* Generate hash from article content (title \+ description \+ URL)  
* Use cryptographic hash function (SHA-256)

Logic:

text

`hash = generate_hash(article.title + article.description + article.url)`  
`IF hash EXISTS IN database:`  
    `DROP article (duplicate)`  
`ELSE:`  
    `STORE hash`  
    `PASS to Layer 3`

## **Layer 3: Fuzzy Title Matching**

Purpose: Detect near-duplicate articles with similar titles

Algorithm: Fuzzy string matching (Levenshtein distance) ,like synonyms etc   
This layer first check in its batch means in feeds that this layer got from layer 2.after passed from this send to check against from db 

Threshold: 50% similarity

Logic:

text

`FOR each stored_title IN database:`  
    `similarity = calculate_fuzzy_match(article.title, stored_title)`  
    `IF similarity >= 0.50:`  
        `DROP article (fuzzy duplicate)`  
        `BREAK`  
`PASS to Layer 4`

## **Layer 4: NER (Named Entity Recognition) Fingerprinting**

Purpose: Identify duplicate articles through entity extraction

Database: Supabase

Process:

1. Extract entities from title: places, people, organizations, dates  
2. Create fingerprint from extracted entities  
3. Compare against stored NER fingerprints  
   THIS LAYER ALSO CHECKS IN ITS BATCH FIRST ,IF PASSED 	then check against its database saved finger prints

Logic:

text

`entities = extract_entities(article.title, article.description)`  
`fingerprint = create_fingerprint(entities)`  
`IF fingerprint EXISTS IN database:`  
    `DROP article (NER duplicate)`  
`ELSE:`  
    `STORE fingerprint`  
    `PASS to Layer 5`

## **Layer 5: Semantic Similarity (Vector Embeddings)**

Purpose: Detect semantically similar articles using vector embeddings

Database: Pinecone vector database

Embedding Storage:

* Convert article title \+ description to embeddings  
* Store in Pinecone with metadata

Threshold: 70% similarity

Logic:

text

`embedding = generate_embedding(article.title + article.description)`  
`similar_articles = pinecone.query(embedding, top_k=5)`  
`FOR each similar IN similar_articles:`  
    `IF similar.score >= 0.70:`  
        `DROP article (semantically duplicate)`  
        `BREAK`  
`STORE embedding IN pinecone`  
`PASS to Feeder`

## **3.4 Final Output**

Articles passing all 7 layers are marked as "Pending" and stored in the Feeder and now guid ,hashes,fingerprints,title and description saved in database because we have unique articles now these can be used for future camparebility, ready for Agent processing.

---

## **4\. Feeder Settings Panel**

## **4.1 Article Fetch Configuration**

Batch Size:

* User selects number of articles to fetch at one time  
* Default: 30 articles  
* Range: 1-100 articles

FIFO Logic:

* If 40 articles pass all layers but user selected 30  
* System takes the 30 newest/latest articles  
* Remaining 10 stay in queue for next fetch

## **4.2 Time Range Settings**

Options:

* 30 minutes old  
* 1 hour old  
* 4 hours old  
* Custom range (X minutes/hours)

## **4.3 Database Statistics Dashboard**

Supabase Database Metrics:

* Total articles stored  
* Total fingerprints saved  
* Total NIR fingerprints saved  
* Total GUIDs saved  
* Total hashes stored  
* Storage persistence: Permanent

Pinecone Database Metrics:

* Total article embeddings stored  
* Embedding content: Title \+ Description

Danger Zone:

* Delete all data option  
* Requires confirmation

## **4.4 Fetch History fetch history shows on feeder page**

Tracking:

* Number of times articles were fetched  
* Timestamp of each fetch  
* Number of articles fetched per operation  
* Articles processed vs. dropped statistics

---

## **5\. Settings Panel \- agent settings**

## **5.1 AI Model Selection**

Fixed Provider: LiteLLM only

Available Models:

* moonshotai/kimi-k2-thinking  
*   
* moonshotai/kimi-k2-instruct-0905  
*   
* openai/gpt-oss-120b

Configuration:

text

`┌─────────────────────────────────────┐`  
`│ AI Model (LiteLLM):                 │`  
`│ ▼ Kimi K2.5                         │`  
`│                                     │`  
`│ ℹ️ Used for all agent operations   │`  
`└─────────────────────────────────────┘`  
`Scraper selection`  
`Now only exa ai`  
`Later we will add more`

## **5.3 Queue Management**

Queue Order:

* FIFO (First In First Out) 

  Batch selection in one batch how much articles be there in queue   
  Configure able 5.10.15.20 

  This is queue setting  
  Actual queue shows on agent page user can see how much articles in queue

---

## **6\. Agent System \- Lite Version**

## **6.1 Agent Architecture**

Framework: Vercel AI SDK (Agentic framework)

Agent Type: Autonomous, dynamic planning agent with snippet-first optimization

Operational Mode: Sequential processing (one feed at a time)

Key Innovation: Snippet-first decision making \- scrape only when necessary

## **6.2 Agent Queue System**

## **6.2.1 Queue Population**

Source: Feeder (Supabase database)

Selection Logic:

sql

`SELECT * FROM articles`   
`WHERE status = 'Pending'`   
`ORDER BY timestamp DESC`   
`LIMIT {user_batch_size}`

Batch Size:

* User-configurable  
* Default: 5 articles  
* Range: 1-20 articles

## **6.2.2 Auto-Trigger Configuration**

Settings:

* Enable/disable auto-agent mode  
* Trigger interval (every 30 minutes, 1 hour, 2 hours)  
* Queue refill logic: When queue is empty, auto-fetch from Feeder  
  These are agent settings   
  In agent page queue component show,agent run history shows and agent streaming shows main agent streaming shows ,vercel supports agent streaming

## **6.3 Agent Workflow \- Snippet-First Approach**

## **Step 1: Article Reading & Post Type Classification**

Input: Article from queue with title and description

Classification Logic:

The agent determines if this is a Simple Update or Long-Form Post:

Simple Update Types:

* Price updates (fuel, gold, currency, commodities)  
* Weather updates  
* Sports scores  
* Stock market updates  
* Routine announcements

Long-Form Post Types:

* Political events  
* Accidents and mishaps  
* Health incidents  
* Economic analysis  
* Social issues  
* Breaking news stories

Post Length Decision:

text

`IF article.category IN ['price_update', 'weather', 'scores', 'routine']:`  
    `post_type = "Simple Update"`  
    `max_words = 50-100`  
    `snippet_only_likely = True`  
`ELSE:`  
    `post_type = "Long-Form Post"`  
    `max_words = 200`  
    `snippet_only_likely = False`

Example Classifications:

| Article Title | Post Type | Max Words | Expected Path |
| :---- | :---- | :---- | :---- |
| "Petrol price increased by Rs 10" | Simple Update | 50-100 | Snippets only |
| "Gold price reaches Rs 250,000 per tola" | Simple Update | 50-100 | Snippets only |
| "Imran Khan had eye surgery" | Long-Form Post | 200 | Snippets \+ Scraping |
| "Pakistan signs trade deal with China" | Long-Form Post | 200 | Snippets \+ Scraping |

## **Step 2: Dynamic Planning Phase**

Purpose: Agent creates information gathering plan

Planning for Simple Updates (e.g., Price Update):

text

`Planning Steps:`  
`1. Verify current price of [commodity]`  
`2. Check if price change reason mentioned (optional)`

`Expected: Answer found in snippets (no scraping needed)`  
If not found ,already he readed the snippets then visits most 3 relvent urls  
And read the data  
And make the post 

Planning for Long-Form Posts (e.g., Imran Khan Surgery):

text

`Planning Steps:`  
`1. Research Imran Khan's current health conditions`  
`2. Find details about the eye surgery/operation`  
`3. Verify current health status post-operation`  
`4. Review relevant medical background`

`Expected: Build complete story (may need scraping)`

## **Step 3: Execution with Snippet-First Logic**

## **Phase A: Query Generation**

Agent generates search query based on first planning step.

Example:

* Planning Step 1: "Verify current petrol price in Pakistan"  
* Generated Query: "Pakistan petrol price today February 2026"

## **Phase B: Brave Search Execution**

1\. Send Query to Brave Search API:

python

`response = await brave_search.search(`  
    `query=generated_query,`  
    `count=10  # Always returns 10 results`  
`)`

2\. Brave Response Structure:

json

`{`  
  `"query": "Pakistan petrol price today February 2026",`  
  `"results": [`  
    `{`  
      `"title": "Petrol Price Update - February 2026",`  
      `"url": "https://dawn.com/petrol-price-update",`  
      `"description": "Latest petrol prices in Pakistan",`  
      `"snippets": [`  
        `"Petrol price in Pakistan increased to Rs 280 per liter",`  
        `"The new price is effective from February 1, 2026",`  
        `"Previous price was Rs 270 per liter",`  
        `"Government announced Rs 10 increase due to global oil prices",`  
        `"Price revision happens every 15 days"`  
      `],`  
      `"age": "2 hours ago",`  
      `"domain": "dawn.com"`  
    `},`  
    `{`  
      `"title": "Pakistan Fuel Prices February 2026",`  
      `"url": "https://geo.tv/fuel-prices",`  
      `"description": "Latest fuel prices",`  
      `"snippets": [`  
        `"Petrol: Rs 280/liter",`  
        `"Diesel: Rs 290/liter",`  
        `"Effective date: Feb 1, 2026",`  
        `"Price increase attributed to international market"`  
      `],`  
      `"age": "3 hours ago",`  
      `"domain": "geo.tv"`  
    `}`  
    `// ... 8 more results with up to 5 snippets each`  
  `]`  
`}`

Total Snippets Available: Up to 50 snippets (10 results × 5 snippets each)

## **Phase C: Snippet Analysis & Decision Making**

Agent's Decision Process:

python

*`# Agent reads ALL snippets from ALL 10 results`*  
`all_snippets = []`  
`for result in search_results:`  
    `all_snippets.extend(result.snippets)`  
    `# Total: Up to 50 snippets available`

*`# Keep snippets in memory for context`*  
`context_snippets = all_snippets`

*`# Agent analyzes if snippets contain sufficient information`*  
`snippet_analysis = agent.analyze_snippets(`  
    `snippets=all_snippets,`  
    `planning_targets=current_targets,`  
    `post_type=post_type`  
`)`

*`# Decision logic`*  
`if snippet_analysis.sufficient:`  
    `# SCENARIO 1: Snippets sufficient - NO SCRAPING NEEDED`  
    `action = "USE_SNIPPETS_ONLY"`  
    `synthesized_info = agent.synthesize_from_snippets(all_snippets)`  
    `proceed_to_post_creation()`  
      
`else:`  
    `# SCENARIO 2: Snippets insufficient - SCRAPING NEEDED`  
    `action = "SELECT_URLS_AND_SCRAPE"`  
    `# Keep snippets in mind for context`  
    `context_from_snippets = agent.extract_context(all_snippets)`  
    `# Select top 3 most relevant URLs`  
    `selected_urls = agent.select_top_3_urls(search_results)`  
    `proceed_to_scraping()`

## **SCENARIO 1: Snippets Sufficient (No Scraping)**

Example: Petrol Price Update

Agent Analysis:

text

`Agent reads 50 snippets and finds:`  
`- Snippet 1: "Petrol price in Pakistan increased to Rs 280 per liter"`  
`- Snippet 4: "Previous price was Rs 270 per liter"`  
`- Snippet 5: "Government announced Rs 10 increase due to global oil prices"`  
`- Snippet 8: "Effective date: Feb 1, 2026"`

`Analysis:`  
`✓ Current price found: Rs 280`  
`✓ Previous price found: Rs 270`  
`✓ Reason found: Global oil prices`  
`✓ Effective date found: Feb 1, 2026`  
`✓ All information targets met from snippets`

`Decision: NO SCRAPING NEEDED`  
`Action: Directly create post using snippet information`

Workflow:

text

`Article → Classify (Simple Update) → Plan → Search (Brave)`   
`→ Analyze 50 Snippets → Snippets Sufficient ✓`   
`→ Create Posts → Save Drafts`

---

## **SCENARIO 2: Snippets Insufficient (Scraping Needed)**

Example: Imran Khan Surgery

Agent Analysis:

text

`Agent reads 50 snippets from 10 results and finds:`  
`- Multiple snippets mention "eye surgery"`  
`- Some mention "PIMS Hospital"`  
`- Some mention "successful operation"`  
`- Basic facts captured`

`But deeper context missing:`  
`✗ What was the specific eye condition?`  
`✗ What type of surgery exactly?`  
`✗ Detailed recovery status?`  
`✗ Medical history context?`

`Analysis:`  
`✓ Basic facts in snippets (keep as context)`  
`✗ Detailed information missing for 200-word post`  
`✗ Need deeper article content for complete story`

`Decision: SCRAPING NEEDED`  
`Action: Keep snippets in memory + scrape top 3 URLs`

## **Phase D: URL Selection (When Scraping Needed)**

Agent Evaluation Criteria:

The agent already readed  all 10 search results (with their snippets) to select the top 3 most relevant URLs:

Selection Factors:

1. Snippet relevance to planning targets (highest weight)  
2. Domain authority (trusted sources preferred)  
3. Recency (newer articles preferred)  
4. Title relevance to search query

Example Selection:

text

`10 Results Available:`

`Selected Top 3:`  
`1. dawn.com/imran-khan-surgery (Score: 95)`  
   `- Snippets: surgery details, hospital, condition`  
   `- Domain: Trusted`  
   `- Age: 2 hours old`  
     
`2. geo.tv/pims-hospital-confirms (Score: 88)`  
   `- Snippets: hospital statement, recovery status`  
   `- Domain: Trusted`  
   `- Age: 3 hours old`  
     
`3. tribune.com.pk/imran-health (Score: 82)`  
   `- Snippets: medical history, previous treatments`  
   `- Domain: Trusted`  
   `- Age: 5 hours old`

`Rejected: 7 URLs with lower relevance scores`

## **Phase E: Scraping with Exa AI**

1\. Send Top 3 URLs to Exa AI:

python

*`# Scrape selected URLs in parallel`*  
`scraping_results = await asyncio.gather(`  
    `exa_ai.extract(url_1),`  
    `exa_ai.extract(url_2),`  
    `exa_ai.extract(url_3)`  
`)`

2\. Wait for All Results:

* Agent waits until all 3 URLs are scraped  
* Blocking wait ensures complete data

3\. Handle Results:

python

`successful_scrapes = []`  
`failed_urls = []`

`for url, result in zip(selected_urls, scraping_results):`  
    `if result.success:`  
        `successful_scrapes.append({`  
            `'url': url,`  
            `'content': result.content,`  
            `'snippets': url.snippets  # Keep snippet context`  
        `})`  
    `else:`  
        `failed_urls.append(url)`  
        `log_error(f"Exa AI failed to scrape: {url}")`

*`# Continue with successful scrapes`*  
*`# No fallback in Lite version (simplified error handling)`*

## **Phase F: Information Synthesis (Snippets \+ Scraped Content)**

Agent combines two information sources:

1\. Context from Brave Snippets (kept in memory):

text

`Snippet Context (50 snippets from 10 results):`  
`- Basic facts and figures`  
`- Multiple source perspectives`  
`- Timeline information`  
`- Quick overview`

2\. Deep Information from Scraped Articles (3 URLs):

text

`Scraped Content (detailed):`  
`- Full article narratives`  
`- Detailed explanations`  
`- Background context`  
`- Quotes and statements`  
`- Complete story arc`

Synthesis Process:

python

`synthesized_information = agent.synthesize(`  
    `snippet_context=all_brave_snippets,  # Broad overview`  
    `scraped_articles=successful_scrapes,  # Deep details`  
    `planning_targets=targets`  
`)`

*`# Agent creates comprehensive understanding:`*  
*`# - Snippets provide breadth (multiple sources, quick facts)`*  
*`# - Scraped content provides depth (detailed narrative)`*  
*`# - Combined = complete, accurate, contextualized post`*

Target Tracking:

text

`Planning Targets:`  
`[✓] Target 1: Current health conditions - ACHIEVED`  
`[✓] Target 2: Surgery details - ACHIEVED`  
`[✓] Target 3: Current status - ACHIEVED`  
`[✓] Target 4: Medical history - ACHIEVED`

`Decision: All targets met → Proceed to Post Creation`

## **Phase G: Iteration Decision**

If all targets achieved:  
→ Proceed to Post Creation (Step 4\)

If targets remain:

1. Generate new query for next pending target  
2. Search again via Brave (get 10 results \+ 50 snippets)  
3. Analyze snippets  
4. Scrape top 3 URLs if needed  
5. Synthesize information  
6. Check targets  
7. Repeat until all targets achieved

Maximum Iterations:

* 3


---

## **Step 4: Post Creation**

Multi-Platform Generation: Create posts for 3 platforms simultaneously

1. Facebook post  
2. Instagram post  
3. X (Twitter) post

Post Requirements Based on Type:

## **For Simple Updates (50-100 words)**

Characteristics:

* Direct, concise information  
* Key fact (price, number, update)  
* Brief context from snippets  
* No story narrative needed

Example \- Petrol Price Post:

text

`📢 Petrol Price Update`

`The government has increased petrol prices in Pakistan. The new rate`   
`is Rs 280 per liter, up from Rs 270 per liter.`

`The Rs 10 increase is due to rising global oil prices. This price is`   
`effective from February 1, 2026.`

`#PetrolPrice #Pakistan #FuelUpdate`

## **For Long-Form Posts (up to 200 words)**

Characteristics:

* Complete narrative with context  
* Story structure: What happened, Why it matters, What's next  
* Background information from snippets  
* Detailed information from scraped articles  
* Engaging and contextualized

Example \- Imran Khan Surgery Post:

text

`🏥 Imran Khan Undergoes Eye Surgery`

`Former Prime Minister Imran Khan underwent successful eye surgery at`   
`PIMS Hospital in Islamabad earlier today. The procedure was performed`   
`to address a cataract condition that had been affecting his vision for`   
`several weeks.`

`According to hospital officials, the surgery lasted approximately one`   
`hour and was completed without complications. Khan is currently in the`   
`recovery ward and is reported to be in stable condition.`

`Medical sources indicate this is not Khan's first eye-related`   
`treatment. He previously received care for a similar condition in 2023.`   
`Doctors have advised a two-week recovery period before he resumes`   
`public activities.`

`The surgery comes at a crucial time as Khan has been actively involved`   
`in political activities. Well-wishers from across the country have sent`   
`their prayers for his speedy recovery.`

`#ImranKhan #Pakistan #HealthUpdate #PIMS`

## **Dynamic Behavior Selection**

Agent selects appropriate tone based on news category:

| News Type | Behavior/Tone | Max Words | Example Phrases |
| :---- | :---- | :---- | :---- |
| Price Update | Informative, straightforward | 50-100 | "New rates...", "Effective from..." |
| Weather Update | Practical, informative | 50-100 | "Forecast shows...", "Expected to..." |
| Political Event | Balanced, factual | 200 | "Sources confirm...", "Officials stated..." |
| Accident/Mishap | Serious, sympathetic | 200 | "Unfortunately...", "Our thoughts..." |
| Good News | Positive, celebratory | 200 | "Great news\!", "Excited to share..." |
| Economic Analysis | Analytical, informative | 200 | "Data shows...", "Analysts indicate..." |
| Healthcare | Educational, informative | 200 | "Here's what you need to know..." |

## **Language Guidelines**

Target Audience: Pakistani users with varying English proficiency

Rules:

* Use simple, everyday English  
* Avoid buzzwords and jargon  
* No complex vocabulary or technical terms  
* Write as people naturally speak  
* Sentence structure: Short and clear (avg. 12-15 words)

Examples:

❌ Avoid:

"The nation's economic trajectory has been impacted by unprecedented fiscal challenges, necessitating comprehensive strategic interventions."

✓ Use:

"Pakistan's economy is facing big money problems. The government needs to make important changes."

## **Platform-Specific Formatting**

Facebook:

* Simple Update: 50-100 words  
* Long-Form: 150-200 words  
* Paragraph breaks for readability  
* Optional emojis for emphasis

Instagram:

* Simple Update: 50-80 words  
* Long-Form: 120-180 words  
* More visual language  
* 5-10 hashtags at end

X (Twitter):

* Simple Update: 100-150 characters  
* Long-Form: 200-280 characters  
* Key information only  
* 1-2 hashtags maximum

## **Step 5: Draft Saving**

Storage Location: Draft section of application

Database Structure:

sql

`posts_table:`  
  `- post_id (UUID)`  
  `- article_id (FK to articles table)`  
  `- platform (facebook/instagram/x)`  
  `- content (text)`  
  `- status (draft/scheduled/published)`  
  `- created_at (timestamp)`  
  `- updated_at (timestamp)`

Post Organization:

* Posts Page with 3 tabs:  
  * Facebook tab (all Facebook drafts)  
  * Instagram tab (all Instagram drafts)  
  * X tab (all X/Twitter drafts)

Platform-Specific Theming:

* Each post displayed with platform-specific UI theme  
* Preview of how post will appear on actual platform  
* Edit/delete options per draft

## **Step 6: Status Update**

Article Status Change:

sql

`UPDATE articles`   
`SET status = 'Posted'`   
`WHERE article_id = {current_article_id}`

Purpose:

* Mark processed articles as complete  
* Prevent duplicate processing  
* Queue will skip "Posted" articles in future fetches  
* Only "Pending" articles enter queue

---

## **6.4 Agent Settings Panel**

Section 1: Queue Configuration

text

`┌─────────────────────────────────────┐`  
`│ Batch Size:                         │`  
`│ ┌─────────────────────────────┐     │`  
`│ │ 5                      [▼]  │     │`  
`│ └─────────────────────────────┘     │`  
`│ How many articles to process        │`  
`│ Range: 1-10 articles                │`  
`└─────────────────────────────────────┘`

text

`┌─────────────────────────────────────┐`  
`│ Auto-Trigger:                       │`  
`│ ☑ Enable automatic agent execution  │`  
`│                                     │`  
`│ Trigger Interval:                   │`  
`│ ○ Every 30 minutes                  │`  
`│ ● Every 1 hour                      │`  
`│ ○ Every 2 hours                     │`  
`└─────────────────────────────────────┘`

---

Section 2: AI Provider

text

`┌─────────────────────────────────────┐`  
`│ AI Provider: LiteLLM (fixed)        │`  
`│                                     │`  
`│ Model Selection:                    │`  
`│ ▼ Kimi K2.5                         │`  
`│                                     │`  
`│ Available models:                   │`  
`│ • Kimi K2 Thinking                  │`  
`│ • Kimi K2 Instruct                  │`  
`│ • Kimi K2.5                         │`  
`│ • GPT-OSS 120B                      │`  
`└─────────────────────────────────────┘`

---

Section 3: Search & Scraping

text

`┌│`  
`│                                     │`  
`│ ✓ Returns 10 results per search     │`  
`│ ✓    │`  
`└─────────────────────────────────────┘`

text

`┌─────────────────────────────────────┐`  
   `│`  
`└─────────────────────────────────────┘`

---

---

## **7\. Posts Page**

## **7.1 Post Display Organization**

Layout: Tab-based interface

Three Tabs:

1. Facebook Tab: All Facebook draft posts  
2. Instagram Tab: All Instagram draft posts  
3. X Tab: All X/Twitter draft posts

## **7.2 Post Preview Features**

Platform-Specific Theming:

* Facebook posts display with Facebook UI styling  
* Instagram posts display with Instagram UI styling  
* X posts display with X/Twitter UI styling

Preview Functionality:

* Shows exactly how post will appear on real platform  
* Character count display  
* Hashtag highlighting  
* Emoji rendering

## **7.3 Post Management Actions**

Available Actions:

* View draft post  
* Edit post content  
* Delete post  
* Schedule for publishing (future feature)  
* Publish directly (future feature)

## **7.4 Filtering & Sorting**

Filter Options:

* By platform  
* By date created  
* By article source  
* By status (draft/scheduled/published)

Sort Options:

* Newest first  
* Oldest first  
* Alphabetical by title

---

