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

Por isso o **modo padrão é `chrome`**, que separa o processo em **duas fases**:

**Fase 1 — Identificação (você, manual):** a ferramenta apenas **abre o seu
Chrome/Edge real** já na tela do PGMEI. **Nenhuma automação toca no navegador
aqui.** Você digita o CNPJ (a ferramenta mostra ele formatado no terminal para
facilitar), clica em **Continuar** e resolve o captcha, como um humano normal.
É justamente esse "não encostar" que despista o hCaptcha.

**Fase 2 — Emissão (automação):** quando você já estiver na tela com **"Emitir
Guia de Pagamento (DAS)"**, volte ao terminal e tecle **ENTER**. Só então a
automação **se conecta** ao navegador e faz o resto sozinha: escolhe o ano,
marca o mês, gera e baixa o PDF. Essas telas **não têm captcha**.

A ferramenta usa um **perfil dedicado e limpo** (`.perfil-chromium/chrome-real`),
separado do seu Chrome pessoal. Esse perfil passa normalmente no hCaptcha (um
navegador limpo é tratado como legítimo). Se algo travar, use `--novo-perfil`
para recomeçar o perfil do zero.

> **Detalhe técnico:** a abertura do navegador **não** usa nenhuma flag de
> automação (`--enable-automation`) e a automação só **se conecta** na fase 2,
> depois da identificação — por isso o hCaptcha não detecta robô.

### Modos disponíveis (`--modo`)

| Modo       | O que faz                                                                    |
|------------|------------------------------------------------------------------------------|
| `chrome`   | **(padrão)** Chrome/Edge real; identificação manual + ENTER; automação segue. |
| `headless` | Chromium oculto (testes/CI; **bloqueado pelo captcha** na identificação).     |
| `headful`  | Chromium empacotado com janela (também costuma ser **bloqueado** pelo captcha).|

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
| `--out`, `-o`   | Diretório de saída (padrão: `./downloads`)          |
| `--modo`        | `chrome` (padrão), `headless`, `headful`            |
| `--novo-perfil` | Recomeça o perfil dedicado do zero                  |
| `--help`, `-h`  | Ajuda                                               |

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
| `MODO`        | `chrome` (padrão), `headless`, `headful`               |
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
