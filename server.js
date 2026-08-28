require('dotenv').config();
const express = require('express');
const { Anthropic } = require('@anthropic-ai/sdk');
const { Pool } = require('pg');
const path = require('path');

const app = express();
app.use(express.json());

// Serve static frontend files (ensure index.html is in a 'public' directory)
app.use(express.static(path.join(__dirname, 'public')));

const anthropic = new Anthropic({ apiKey: process.env.CLAUDE_API_KEY });
const pool = new Pool({ 
    connectionString: process.env.DATABASE_URL, 
    ssl: { rejectUnauthorized: false } 
});

// Helper function to safely extract and parse JSON from Claude responses
function parseClaudeJSON(rawText) {
    const cleanedText = rawText.replace(/```json\s?|```/g, '').trim();
    return JSON.parse(cleanedText);
}

// 1. Endpoint: Live Verification & Hallucination Interception Pipeline
app.post('/api/v1/verify-document', async (req, res) => {
    const { document_name, text, scanned_by } = req.body;

    if (!text) {
        return res.status(400).json({ error: "Missing required 'text' field." });
    }

    try {
        // Enforce deterministic output from Claude API
        const aiResponse = await anthropic.messages.create({
            model: "claude-3-5-sonnet-20241022",
            max_tokens: 1000,
            temperature: 0.0,
            system: "You are an Enterprise Legal Verification Pipeline. Analyze legal text or citations. Output strict raw JSON ONLY (no markdown formatting, no code blocks) with keys: 'has_hallucination' (boolean), 'risk_score' (number 0-100), 'reasoning' (string).",
            messages: [{ role: "user", content: `Verify the authenticity and logical coherence of this text: ${text}` }]
        });

        const rawContent = aiResponse.content[0].text;
        const result = parseClaudeJSON(rawContent);

        const status = result.has_hallucination ? 'Intercepted (Fabricated Data)' : 'Cleared for Court';

        // 2. Insert record into Neon PostgreSQL verification_logs table
        await pool.query(
            `INSERT INTO verification_logs (document_name, scanned_by, status, risk_score) VALUES ($1, $2, $3, $4)`,
            [document_name || 'Interactive_Scan.txt', scanned_by || 'Enterprise_User', status, result.risk_score || 0]
        );

        res.json({
            status: status,
            risk_score: result.risk_score || 0,
            details: result.reasoning
        });

    } catch (err) {
        console.error("Pipeline Error:", err);
        res.status(500).json({ error: "Pipeline processing failed", details: err.message });
    }
});

// 3. Endpoint: Fetch Live Audit Logs from Neon DB
app.get('/api/v1/audit-logs', async (req, res) => {
    try {
        const { rows } = await pool.query('SELECT * FROM verification_logs ORDER BY created_at DESC LIMIT 20');
        res.json(rows);
    } catch (err) {
        console.error("Database Retrieval Error:", err);
        res.status(500).json({ error: "Database retrieval failed" });
    }
});

const PORT = process.env.PORT || 3000;
app.listen(PORT, () => console.log(`KeelerTech Engine active on port ${PORT}`));
