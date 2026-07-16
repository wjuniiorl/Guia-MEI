# Guia-MEI · Emissão automática do DAS (PGMEI)

Automação que emite a **Guia de Pagamento (DAS)** do MEI no portal do Simples
Nacional (PGMEI), preenchendo o CNPJ, escolhendo o **ano** e o **mês** de
apuração, gerando o DAS e **salvando o PDF** com o nome do contribuinte.

Funciona por **linha de comando (CLI)** e por **interface web**.

---

## ⚠️ Importante: captcha (hCaptcha)

O portal do PGMEI é protegido por **hCaptcha invisível** na tela de
identificação. Ele analisa o comportamento e **bloqueia acessos automatizados**
(o portal responde: *"Impedido por proteção Captcha. Comportamento de Robô"*).

Por isso a automação usa o **modo assistido** (padrão):

1. Tenta emitir de forma **oculta (headless)**, aproveitando os cookies já
   salvos no perfil.
2. **Se** o captcha desafiar, a **janela real do navegador abre** para você
   resolver o captcha manualmente.
3. Assim que a identificação é aceita, a automação **continua sozinha** de onde
   parou (escolhe o ano, marca o mês, gera e baixa o PDF).

Um **perfil persistente** (`.perfil-chromium/`) guarda os cookies, o que
costuma **reduzir a frequência** dos desafios nas execuções seguintes.

> Numa máquina normal (IP residencial + navegador visível), o hCaptcha invisível
> muitas vezes passa **sem desafio nenhum**. O bloqueio é mais comum em
> servidores/IPs de datacenter.

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
| `--modo`       | `assistido` (padrão), `headless` ou `headful`        |
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

| Variável | Descrição                                             |
|----------|-------------------------------------------------------|
| `PORT`   | Porta do servidor (padrão `3000`)                     |
| `MODO`   | `assistido` (padrão), `headless` ou `headful`         |

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
