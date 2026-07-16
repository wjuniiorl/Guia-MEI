// Servidor web para emissão do DAS do MEI via interface gráfica.
//
// Sobe um servidor Express que serve a UI (public/index.html) e expõe uma
// API POST /api/emitir que executa a automação e devolve o PDF para download.

import express from 'express';
import path from 'node:path';
import fs from 'node:fs';
import { fileURLToPath } from 'node:url';
import { emitirDAS, cnpjValido, MESES_PT } from './pgmei.js';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const ROOT = path.resolve(__dirname, '..');
const PUBLIC_DIR = path.join(ROOT, 'public');
const DOWNLOADS_DIR = path.join(ROOT, 'downloads');

const app = express();
const PORT = process.env.PORT || 3000;
// Modo do navegador: assistido (padrão) | headless | headful.
// No modo assistido, se o hCaptcha desafiar, a janela do navegador abre na
// máquina onde o servidor roda para o usuário resolver.
const MODO = ['chrome', 'headless', 'headful'].includes(process.env.MODO) ? process.env.MODO : 'chrome';

app.use(express.json());
app.use(express.static(PUBLIC_DIR));

// Metadados úteis para a UI (lista de meses).
app.get('/api/meses', (_req, res) => {
  res.json(MESES_PT.map((nome, i) => ({ valor: i + 1, nome })));
});

// Emite o DAS e devolve o PDF como download.
app.post('/api/emitir', async (req, res) => {
  const { cnpj, ano, mes } = req.body || {};

  if (!cnpj || !ano || !mes) {
    return res.status(400).json({ erro: 'Informe cnpj, ano e mes.' });
  }
  if (!cnpjValido(cnpj)) {
    return res.status(400).json({ erro: 'CNPJ inválido.' });
  }

  try {
    const resultado = await emitirDAS({
      cnpj,
      ano,
      mes,
      modo: MODO,
      outputDir: DOWNLOADS_DIR,
      onLog: (msg) => console.log(`[web] ${msg}`),
      // Sem confirmação por terminal na web: a automação conecta e aguarda
      // a identificação ser concluída na janela do navegador (tela de emissão).
    });

    // Devolve o PDF para download com o nome do contribuinte.
    res.setHeader('Content-Type', 'application/pdf');
    res.setHeader(
      'Content-Disposition',
      `attachment; filename="${encodeURIComponent(resultado.fileName)}"`
    );
    res.setHeader('X-Contribuinte', encodeURIComponent(resultado.nome || ''));
    res.setHeader('X-Periodo', encodeURIComponent(resultado.periodo || ''));
    res.setHeader('X-Valor', encodeURIComponent(resultado.valor || ''));
    fs.createReadStream(resultado.pdfPath).pipe(res);
  } catch (err) {
    console.error('[web] Erro na emissão:', err.message);
    res.status(500).json({ erro: err.message });
  }
});

app.listen(PORT, () => {
  fs.mkdirSync(DOWNLOADS_DIR, { recursive: true });
  console.log(`\n  Guia-MEI rodando em: http://localhost:${PORT}`);
  console.log(`  Modo do navegador: ${MODO}`);
  console.log(`  PDFs salvos em: ${DOWNLOADS_DIR}\n`);
});
