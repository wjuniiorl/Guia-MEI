#!/usr/bin/env node
// CLI para emissão do DAS do MEI.
//
// Uso:
//   node src/cli.js --cnpj 03351763000181 --ano 2026 --mes 6
//   node src/cli.js -c 03.351.763/0001-81 -a 2026 -m 6 --modo headful --out ./guias
//
// Opções:
//   --cnpj, -c   CNPJ (com ou sem formatação)          [obrigatório]
//   --ano,  -a   Ano-calendário (ex: 2026)             [obrigatório]
//   --mes,  -m   Mês de apuração (1..12)               [obrigatório]
//   --out,  -o   Diretório de saída (default: ./downloads)
//   --modo       chrome | assistido | headless | headful (default: chrome)
//   --help, -h   Mostra esta ajuda
//
// Sobre o captcha: o portal usa hCaptcha invisível que bloqueia navegadores de
// automação. No modo "chrome" (padrão), a ferramenta abre o SEU Chrome/Edge
// real e se conecta a ele — você resolve a identificação/captcha uma vez e a
// automação assume o resto (ano, mês, geração e download do PDF).

import { emitirDAS, cnpjValido } from './pgmei.js';

function parseArgs(argv) {
  const args = {};
  const alias = { c: 'cnpj', a: 'ano', m: 'mes', o: 'out', h: 'help' };
  for (let i = 0; i < argv.length; i++) {
    let key = argv[i];
    if (!key.startsWith('-')) continue;
    key = key.replace(/^--?/, '');
    if (key === 'help' || key === 'h') { args.help = true; continue; }
    key = alias[key] || key;
    const next = argv[i + 1];
    if (next !== undefined && !next.startsWith('-')) {
      args[key] = next;
      i++;
    } else {
      args[key] = true;
    }
  }
  return args;
}

function ajuda() {
  console.log(`
Guia-MEI — Emissão automática do DAS (PGMEI)

Uso:
  node src/cli.js --cnpj <CNPJ> --ano <ANO> --mes <MES> [opções]

Opções:
  --cnpj, -c   CNPJ (com ou sem formatação)          [obrigatório]
  --ano,  -a   Ano-calendário (ex: 2026)             [obrigatório]
  --mes,  -m   Mês de apuração (1..12)               [obrigatório]
  --out,  -o   Diretório de saída (default: ./downloads)
  --modo       chrome | assistido | headless | headful (default: chrome)
  --help, -h   Mostra esta ajuda

Captcha: no modo "chrome" (padrão), a ferramenta abre o seu Chrome/Edge real e
se conecta a ele. Você resolve a identificação/captcha uma vez e a automação
assume o resto. Use CHROME_PATH para apontar o executável, se necessário.

Exemplo:
  node src/cli.js -c 03351763000181 -a 2026 -m 6
`);
}

async function main() {
  const args = parseArgs(process.argv.slice(2));

  if (args.help || (!args.cnpj && !args.ano && !args.mes)) {
    ajuda();
    process.exit(args.help ? 0 : 1);
  }

  const faltando = [];
  if (!args.cnpj) faltando.push('--cnpj');
  if (!args.ano) faltando.push('--ano');
  if (!args.mes) faltando.push('--mes');
  if (faltando.length) {
    console.error(`Erro: parâmetros obrigatórios ausentes: ${faltando.join(', ')}`);
    ajuda();
    process.exit(1);
  }

  if (!cnpjValido(args.cnpj)) {
    console.error(`Erro: CNPJ inválido: ${args.cnpj}`);
    process.exit(1);
  }

  const modo = ['chrome', 'assistido', 'headless', 'headful'].includes(args.modo) ? args.modo : 'chrome';

  try {
    const resultado = await emitirDAS({
      cnpj: args.cnpj,
      ano: args.ano,
      mes: args.mes,
      modo,
      outputDir: args.out,
      onLog: (msg) => console.log(`  › ${msg}`),
    });

    console.log('\n✅ DAS emitido com sucesso!');
    console.log(`   Contribuinte: ${resultado.nome || '(não identificado)'}`);
    console.log(`   Período:      ${resultado.periodo}`);
    if (resultado.valor) console.log(`   Valor:        ${resultado.valor}`);
    console.log(`   Arquivo:      ${resultado.pdfPath}`);
    process.exit(0);
  } catch (err) {
    console.error(`\n❌ Falha na emissão: ${err.message}`);
    process.exit(1);
  }
}

main();
