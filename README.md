# Guia-MEI · Emissão automática do DAS (PGMEI)

Automação que emite a **Guia de Pagamento (DAS)** do MEI no portal do Simples
Nacional (PGMEI), preenchendo o CNPJ, escolhendo o **ano** e o **mês** de
apuração, gerando o DAS e **salvando o PDF** com o nome do contribuinte.

Funciona por **linha de comando (CLI)** e por **interface web**.

---

## ⚠️ Importante: captcha (hCaptcha)

A tela de identificação do PGMEI é protegida por **hCaptcha invisível** que
**detecta e bloqueia navegadores de automação** (Playwright/Selenium) — muitas
vezes sem nem exibir um desafio, apenas recusando:
*"Impedido por proteção Captcha. Comportamento de Robô"*.

Por isso o **modo padrão é `chrome`**, que usa o **seu Chrome (ou Edge) real**:

1. A ferramenta **abre o seu Chrome/Edge de verdade** (como um navegador normal,
   sem flags de automação) e **se conecta** a ele.
2. Ela **preenche o CNPJ** e clica em Continuar. Se o captcha aparecer, **você
   resolve** na janela (é a única etapa manual).
3. Assim que a identificação é aceita, a automação **assume sozinha**: escolhe o
   ano, marca o mês, gera e baixa o PDF.

Como o navegador não nasce marcado como automação, o hCaptcha tem **muito mais
chance de liberar** (ou de mostrar um desafio *solucionável* em vez do bloqueio).
Um **perfil dedicado** (`.perfil-chromium/chrome-real`) guarda os cookies,
reduzindo desafios nas próximas execuções.

> Nada é 100% garantido contra o hCaptcha: se ainda assim bloquear, você pode
> fazer **toda** a identificação manualmente na janela que abriu — a automação
> espera e continua a partir do momento em que você estiver identificado.

### Modos disponíveis (`--modo`)

| Modo        | O que faz                                                                 |
|-------------|---------------------------------------------------------------------------|
| `chrome`    | **(padrão)** Abre o Chrome/Edge real e conecta. Melhor contra o captcha.   |
| `assistido` | Tenta o Chromium oculto; se bloquear, cai para o Chrome real.             |
| `headless`  | Chromium oculto (para testes/CI; falha se o captcha desafiar).            |
| `headful`   | Chromium empacotado com janela (costuma ser bloqueado pelo hCaptcha).     |

> Se a ferramenta não encontrar o Chrome/Edge automaticamente, aponte o caminho
> com a variável `CHROME_PATH` (ex.: `set CHROME_PATH=C:\caminho\chrome.exe`).

---

## Requisitos

- **Node.js 18+** (testado no Node 22)
- Navegador do Playwright (Chromium)

## Instalação

```bash
npm install
npx playwright install chromium   # baixa o Chromium usado pela automação
```

## Uso — Linha de comando (CLI)

```bash
node src/cli.js --cnpj 03351763000181 --ano 2026 --mes 6
```

Opções:

| Opção          | Descrição                                            |
|----------------|------------------------------------------------------|
| `--cnpj`, `-c` | CNPJ (com ou sem formatação) **[obrigatório]**       |
| `--ano`, `-a`  | Ano-calendário, ex.: `2026` **[obrigatório]**        |
| `--mes`, `-m`  | Mês de apuração, `1`..`12` **[obrigatório]**         |
| `--out`, `-o`  | Diretório de saída (padrão: `./downloads`)           |
| `--modo`       | `chrome` (padrão), `assistido`, `headless`, `headful`|
| `--help`, `-h` | Ajuda                                                |

Exemplo — DAS de **Junho/2026** (que vence em julho):

```bash
node src/cli.js -c 03351763000181 -a 2026 -m 6
```

O PDF é salvo como, por exemplo:
`downloads/03.351.763 MARIA DO ROSARIO RUIZ SOUZA - Junho-2026.pdf`

## Uso — Interface web

```bash
npm start
```

Abra **http://localhost:3000**, informe o CNPJ, escolha o ano e o mês e clique
em **"Emitir e baixar DAS"**. Se o captcha desafiar, a janela do navegador abre
para você resolver; ao final o PDF é baixado automaticamente.

Variáveis de ambiente:

| Variável      | Descrição                                              |
|---------------|--------------------------------------------------------|
| `PORT`        | Porta do servidor (padrão `3000`)                      |
| `MODO`        | `chrome` (padrão), `assistido`, `headless`, `headful`  |
| `CHROME_PATH` | Caminho do Chrome/Edge, se não for detectado           |

> A interface web executa o navegador **na mesma máquina do servidor**. Rode
> localmente para que a janela do captcha apareça na sua tela.

---

## Como funciona (passo a passo automatizado)

1. Acessa `.../pgmei.app/Identificacao`
2. Preenche o campo **CNPJ** e clica em **Continuar** *(hCaptcha aqui)*
3. Seleciona **"Emitir Guia de Pagamento (DAS)"**
4. Seleciona o **ano-calendário** e clica em **Ok**
5. Marca o **período de apuração** (mês) e clica em **Apurar/Gerar DAS**
6. Clica em **Imprimir/Visualizar PDF** e **salva o PDF** com o nome do
   contribuinte

## Estrutura do projeto

```
src/
  pgmei.js     Núcleo da automação (Playwright) + modo assistido de captcha
  cli.js       Interface de linha de comando
  server.js    Servidor web (Express) + API
public/
  index.html   Interface web (formulário)
downloads/     PDFs gerados (ignorado no git)
```

## Observações

- **Um mês por execução**, conforme o passo a passo do portal.
- Use apenas para CNPJs que você tem autorização para administrar.
- O portal pode mudar o layout/versão a qualquer momento; se algum seletor
  quebrar, ajuste em `src/pgmei.js`.
