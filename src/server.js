// Servidor web: interface para emitir o DAS de vários meses e gerenciar clientes.

import express from 'express';
import path from 'node:path';
import fs from 'node:fs';
import { fileURLToPath } from 'node:url';
import { emitirLote, cnpjValido, MESES_PT } from './pgmei.js';
import {
  listarClientes, adicionarCliente, editarCliente, removerCliente, importarTexto,
  setAtivo, setTodosAtivos,
} from './clientes.js';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const ROOT = path.resolve(__dirname, '..');
const PUBLIC_DIR = path.join(ROOT, 'public');
const DOWNLOADS_DIR = path.join(ROOT, 'downloads');

const app = express();
const PORT = process.env.PORT || 3000;

app.use(express.json({ limit: '1mb' }));
app.use(express.static(PUBLIC_DIR));

// ------------------------- Metadados -------------------------
app.get('/api/meses', (_req, res) => {
  res.json(MESES_PT.map((nome, i) => ({ valor: i + 1, nome })));
});

// ------------------------- Clientes --------------------------
app.get('/api/clientes', (_req, res) => res.json(listarClientes()));

app.post('/api/clientes', (req, res) => {
  try { res.json(adicionarCliente(req.body || {})); }
  catch (e) { res.status(400).json({ erro: e.message }); }
});

app.put('/api/clientes/:id', (req, res) => {
  try { res.json(editarCliente(req.params.id, req.body || {})); }
  catch (e) { res.status(400).json({ erro: e.message }); }
});

app.delete('/api/clientes/:id', (req, res) => {
  try { removerCliente(req.params.id); res.json({ ok: true }); }
  catch (e) { res.status(400).json({ erro: e.message }); }
});

app.post('/api/clientes/importar', (req, res) => {
  try { res.json(importarTexto((req.body || {}).texto || '')); }
  catch (e) { res.status(400).json({ erro: e.message }); }
});

app.put('/api/clientes/:id/ativo', (req, res) => {
  try { res.json(setAtivo(req.params.id, (req.body || {}).ativo)); }
  catch (e) { res.status(400).json({ erro: e.message }); }
});

app.post('/api/clientes/ativos-todos', (req, res) => {
  try { setTodosAtivos((req.body || {}).ativo); res.json({ ok: true }); }
  catch (e) { res.status(400).json({ erro: e.message }); }
});

// ------------------------- Emissão ---------------------------
// Responde como SSE (event-stream) para mostrar o progresso ao vivo.
app.post('/api/emitir', async (req, res) => {
  const { cnpj, ano, meses, invisivel } = req.body || {};

  if (!cnpj || !ano || !Array.isArray(meses) || !meses.length) {
    return res.status(400).json({ erro: 'Informe cnpj, ano e ao menos um mês.' });
  }
  if (!cnpjValido(cnpj)) return res.status(400).json({ erro: 'CNPJ inválido.' });

  res.setHeader('Content-Type', 'text/event-stream');
  res.setHeader('Cache-Control', 'no-cache');
  res.setHeader('Connection', 'keep-alive');
  const send = (evento, dados) => res.write(`event: ${evento}\ndata: ${JSON.stringify(dados)}\n\n`);

  try {
    const resultado = await emitirLote({
      cnpj,
      ano,
      meses: meses.map(Number),
      modo: 'chrome',
      auto: true,               // preenche CNPJ e clica Continuar sozinho
      minimizar: Boolean(invisivel),
      outputDir: DOWNLOADS_DIR,
      onLog: (msg) => send('log', { msg }),
      onProgresso: (p) => send('progresso', p),
    });
    send('done', resultado);
  } catch (e) {
    console.error('[web] Erro na emissão:', e.message);
    send('erro', { erro: e.message });
  }
  res.end();
});

// Baixa um PDF já gerado (aceita o caminho relativo ano/mês/arquivo.pdf,
// resolvido com segurança dentro da pasta downloads).
app.get('/api/download', (req, res) => {
  const rel = String(req.query.file || '');
  const full = path.resolve(DOWNLOADS_DIR, rel);
  if (!full.startsWith(DOWNLOADS_DIR) || !fs.existsSync(full)) {
    return res.status(404).json({ erro: 'Arquivo não encontrado.' });
  }
  res.download(full);
});

app.listen(PORT, () => {
  fs.mkdirSync(DOWNLOADS_DIR, { recursive: true });
  console.log(`\n  Guia-MEI rodando em: http://localhost:${PORT}`);
  console.log(`  PDFs salvos em: ${DOWNLOADS_DIR}\n`);
});
