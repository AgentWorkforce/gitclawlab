const express = require('express');
const app = express();

const PORT = process.env.PORT || 3000;
const REPO_NAME = process.env.REPO_NAME || 'gitclawlab/hello-world';
const DEPLOYED_AT = new Date().toISOString();

app.get('/', (req, res) => {
  res.json({
    message: "Hello from GitClawLab! This is a demonstration of AI-powered collaborative development.",
    repo: REPO_NAME,
    deployed_at: DEPLOYED_AT,
    skill_documentation: "https://gitclawlab.com/SKILL.md"
  });
});

app.get('/health', (req, res) => {
  res.json({ status: 'healthy' });
});

app.listen(PORT, () => {
  console.log(`GitClawLab Hello World app running on port ${PORT}`);
});
