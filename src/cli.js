#!/usr/bin/env node
// CLI para emissão do DAS do MEI.
//
// Uso:
//   node src/cli.js --cnpj 29249163000194 --ano 2026 --mes 6
//   node src/cli.js -c 29.249.163/0001-94 -a 2026 -m 6 --out ./guias
//
// No modo padrão ('chrome'): a ferramenta abre o SEU Chrome/Edge real, você faz
// a identificação (CNPJ + Continuar + captcha) manualmente e, ao voltar aqui e
// teclar ENTER, a automação assume e emite/baixa o PDF. Nenhuma automação toca
// no navegador durante a identificação — é o que despista o hCaptcha.

import readline from 'node:readline';
import { emitirLote, cnpjValido } from './pgmei.js';

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
    if (next !== undefined && !next.startsWith('-')) { args[key] = next; i++; }
    else args[key] = true;
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
  --mes,  -m   Mês (1..12) ou vários: 6,7,8          [obrigatório]
  --out,  -o   Diretório de saída (default: ./downloads)
  --modo       chrome | headless | headful (default: chrome)
  --auto       preenche o CNPJ e clica Continuar sozinho
  --atrasadas  emite também as guias em atraso (situação "Devedor")
  --min        abre a janela minimizada ("invisível", mas passa no captcha)
  --headless   (experimental) headless de verdade — costuma ser bloqueado
  --novo-perfil  Recomeça o perfil dedicado do zero (use se algo travar)
  --help, -h   Mostra esta ajuda

Dica: para rodar sem a janela na sua frente, use  --auto --min
(o Chrome abre minimizado, passa no captcha e fecha sozinho).

Modo 'chrome' (padrão): abre o seu Chrome/Edge real com um perfil dedicado e
limpo. Você faz a identificação (CNPJ + Continuar + captcha) e tecla ENTER aqui;
a automação emite e baixa o PDF. Use CHROME_PATH para apontar o executável, se
não for detectado.

Exemplo:
  node src/cli.js -c 29249163000194 -a 2026 -m 6
`);
}

/** Aguarda o usuário teclar ENTER. */
function esperarEnter(mensagem) {
  return new Promise((resolve) => {
    const rl = readline.createInterface({ input: process.stdin, output: process.stdout });
    rl.question(mensagem, () => { rl.close(); resolve(); });
  });
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

  const modo = ['chrome', 'headless', 'headful'].includes(args.modo) ? args.modo : 'chrome';
  // Aceita um mês (-m 6) ou vários separados por vírgula (-m 6,7,8).
  const meses = String(args.mes).split(',').map((s) => Number(s.trim())).filter(Boolean);

  try {
    const { nome, resultados } = await emitirLote({
      cnpj: args.cnpj,
      ano: args.ano,
      meses,
      modo,
      outputDir: args.out,
      novoPerfil: Boolean(args['novo-perfil']),
      // headless de verdade exige preenchimento automático (não há janela p/ interagir).
      auto: Boolean(args.auto) || Boolean(args.headless),
      minimizar: Boolean(args.min),
      chromeHeadless: Boolean(args.headless),
      incluirAtrasadas: Boolean(args.atrasadas),
      onLog: (msg) => console.log(`  › ${msg}`),
      // No modo chrome manual, aguarda o ENTER após a identificação. Com --auto
      // ou --headless a automação preenche/clica sozinha, então não pede ENTER.
      confirmar: (modo === 'chrome' && !args.auto && !args.headless)
        ? () => esperarEnter('\n  ➤ Depois de estar identificado na janela, tecle ENTER aqui para continuar... ')
        : undefined,
    });

    const ok = resultados.filter((r) => r.ok);
    console.log(`\n${ok.length === resultados.length ? '✅' : '⚠️'} ${ok.length}/${resultados.length} guia(s) emitida(s)`);
    console.log(`   Contribuinte: ${nome || '(não identificado)'}`);
    for (const r of resultados) {
      if (r.ok) console.log(`   ✔ ${r.periodo} — ${r.valor || ''}  →  ${r.pdfPath}`);
      else console.log(`   ✖ ${r.periodo} — FALHOU: ${r.erro}`);
    }
    process.exit(ok.length ? 0 : 1);
  } catch (err) {
    console.error(`\n❌ Falha na emissão: ${err.message}`);
    process.exit(1);
  }
}

main();
