# Guia-MEI · Emissão automática do DAS (PGMEI)

Automação que emite a **Guia de Pagamento (DAS)** do MEI no portal do Simples
Nacional (PGMEI), preenchendo o CNPJ, escolhendo o **ano** e o **mês** de
apuração, gerando o DAS e **salvando o PDF** com o nome do contribuinte.

Funciona por **interface desktop (Python)** e por **linha de comando (CLI)**.

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
| `--mes`, `-m`  | Mês `1`..`12` — ou vários: `6,7,8` **[obrigatório]** |
| `--out`, `-o`   | Diretório de saída (padrão: `./downloads`)          |
| `--modo`        | `chrome` (padrão), `headless`, `headful`            |
| `--auto`        | (experimental) preenche o CNPJ e clica Continuar sozinho |
| `--novo-perfil` | Recomeça o perfil dedicado do zero                  |
| `--help`, `-h`  | Ajuda                                               |

> **`--auto`:** tenta preencher o CNPJ e clicar em Continuar automaticamente. Se
> o hCaptcha bloquear ("Comportamento de Robô"), rode **sem** `--auto` (você faz
> a identificação manualmente e tecla ENTER).

Exemplo — DAS de **Junho/2026** (que vence em julho):

```bash
node src/cli.js -c 03351763000181 -a 2026 -m 6
```

O PDF é salvo como, por exemplo:
`downloads/03.351.763 MARIA DO ROSARIO RUIZ SOUZA - Junho-2026.pdf`

## Uso — Interface desktop (Python)

Janela nativa e moderna (CustomTkinter) que usa o motor Node por baixo.

```bash
pip install -r requirements.txt   # instala o customtkinter (uma vez)
python app.py                     # abre a janela
```

No Windows, dá para abrir com **duplo clique** em `abrir-interface.bat`.

Na janela:
- **Aba "Emitir DAS"**: marque **um ou vários clientes** (só os **ativos**
  aparecem), escolha o **ano** e os **meses**. Opções: *"Incluir guias em atraso
  (Devedor)"* e *"Janela invisível"*. Clique em **Emitir DAS** — o progresso
  aparece ao vivo e os PDFs vão para `downloads/ANO/MÊS/`.
- **Aba "Clientes"**: adicionar / editar / excluir, **ativar/desativar** cada um
  e **importar** uma lista (cole nome + CNPJ por linha).

Os clientes ficam salvos **apenas na sua máquina**, em `dados/clientes.json`
(fora do Git — dados pessoais não vão para o repositório).

> Requer **Python 3.9+** e **Node.js** instalados. A interface Python usa o motor
> Node (`src/cli.js`) por baixo — a lógica anti-captcha fica reaproveitada.

## Guias em atraso (situação "Devedor")

Se você marcar *"Incluir guias em atraso"*, ao emitir um mês a ferramenta também
detecta os períodos com situação **Devedor** (vencidos e não pagos) do mesmo ano
e **emite cada um**, salvando na **pasta do mês selecionado** (o arquivo mantém
o nome da competência real de cada guia).

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
app.py             Interface desktop (CustomTkinter)
clientes_store.py  Cadastro de clientes (Python)
clientes-iniciais.json  Lista inicial de clientes (semeada na 1ª vez)
src/
  pgmei.js         Núcleo da automação (Playwright) — motor de emissão
  cli.js           Linha de comando (usada pela interface Python)
downloads/         PDFs gerados: ANO/MÊS/ (ignorado no git)
dados/             clientes.json (ignorado no git)
```

## Observações

- Emite **um ou vários meses** numa única identificação (útil para gerar o ano todo de uma vez).
- Use apenas para CNPJs que você tem autorização para administrar.
- O portal pode mudar o layout/versão a qualquer momento; se algum seletor
  quebrar, ajuste em `src/pgmei.js`.
