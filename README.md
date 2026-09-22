# Spectral Resynth

Protótipo recriado do zero. Sem dependências, build ou conexão com serviços externos.

## Executar

Extraia o ZIP. Na pasta que contém `index.html`, execute um servidor local:

```sh
python -m http.server 8080 --bind 127.0.0.1
```

Se você usa Node.js em vez de Python, execute `node server.cjs`.
Abra http://localhost:8080 em Chrome ou Edge. O teclado virtual também funciona
em outros navegadores com Web Audio. Abrir por duplo clique pode restringir MIDI.

## Usar

1. Clique em **Novo sample** e importe um áudio. Na linha do tempo, arraste para selecionar até 10 segundos; ajuste as bordas ou digite início e fim. Use **+**, **−**, **Ver tudo** e a barra de navegação para localizar o timbre.
2. Informe a fundamental manualmente. C4 = MIDI 60; C3 = MIDI 48.
3. Clique em **Analisar amostra** e aguarde a reconstrução. A importação dá lugar
   aos resultados com uma transição de um segundo.
4. Mova o controle de 25% a 100% e compare **Original** / **Resíntese**.
   Cada alteração aplica o refinamento automaticamente e prepara as 88 notas de um piano (Lá0–Dó8). Acompanhe a barra de progresso; uma nova seleção interrompe os cálculos anteriores.
5. Toque no teclado virtual ou autorize **Conectar MIDI**.
6. Antes de salvar, **Baixar resíntese WAV** exporta o resultado refinado na fundamental, mono, 48 kHz,
   PCM de 16 bits.
7. Clique em **Salvar instrumento**, confira o nome sugerido a partir do arquivo
   importado e confirme. O original é descartado e a comparação sai do layout.

Todos os arquivos são processados localmente no navegador. Nenhum áudio é enviado.

## Interface e biblioteca

- O cabeçalho mede o pico de saída em **dBFS**, com régua de −60 a 0, retenção de
  pico por 1 segundo e indicação CLIP por 1,5 segundo ao atingir 0 dBFS. A leitura
  usa amostras após o volume/compressor; não mede pressão sonora, LUFS ou true peak.
  Referência de escala: [mesa Shure SCM820](https://pubs.shure.com/view/guide/SCM820/en-US.pdf).
- **Memória JS** mostra uma estimativa em MB (base 1024), atualizada a cada 2 segundos
  pela API `performance.memory`, quando disponível. Não representa a RAM total do
  aplicativo: áudio, workers e outras alocações podem ficar fora dessa leitura.
  Navegadores sem a API mostram **N/D**. Consulte as
  [limitações da API](https://developer.mozilla.org/en-US/docs/Web/API/Performance/memory).

- Cabeçalho e barra lateral sempre visíveis; apenas a lista de samples tem rolagem
  vertical independente. Os controles se adaptam à área disponível da janela.
- **Novo sample** abre uma importação vazia. **Reimportar sample** permite substituir
  o áudio do sample selecionado ou ajustar a fundamental e analisar novamente.
- Novos samples ficam em edição até **Salvar instrumento**. A biblioteca local
  (IndexedDB) guarda trajetórias de frequência, amplitude e fase, fundamental,
  parciais, resultado do refinamento e os dados de visualização do espectro. Não grava o WAV
  original nem o áudio reconstruído. O original só é liberado após a confirmação
  de que a gravação no dispositivo foi concluída.
- Ao abrir um instrumento salvo, o áudio é reconstruído temporariamente na memória
  para o teclado/MIDI, sem repetir a análise. Trocar de instrumento libera esse
  buffer. A seleção de parciais fica bloqueada após salvar; ADSR e nome continuam editáveis.
- Instrumentos salvos não exibem importação nem comparação. Volume e parada ficam
  junto ao teclado. Para comparar com o original, importe o arquivo como novo sample.
- O botão **⋯** ao lado de cada nome permite **Renomear** ou **Excluir som salvo**.
  A exclusão remove o registro local e interrompe sua reprodução caso esteja ativo.
  Nomes longos podem ser percorridos horizontalmente na lista.
- Samples de versões anteriores continuam disponíveis com comparação até serem
  convertidos explicitamente pelo botão **Salvar instrumento**.
- Instrumentos antigos mantêm os parâmetros de suavização para compatibilidade. Os sliders foram removidos; o refinamento é automático.
- O armazenamento pertence ao navegador e ao endereço usados para abrir o app.
  Limpar os dados do site também apaga a biblioteca. Se não houver espaço ou o
  armazenamento estiver indisponível, o salvamento informa a falha e mantém o
  original na sessão. Samples ainda não salvos são descartados ao sair da edição.
- Em telas compactas, textos auxiliares são reduzidos ou ocultos para manter os
  controles visíveis. A preferência do sistema por movimento reduzido é respeitada.
- A interface continua sendo web; a portabilidade nativa para iOS não faz parte
  desta alteração. A primeira análise mantém o comportamento anterior.

## Processamento paralelo

O orçamento de workers é `max(1, hardwareConcurrency - 2)`: mantém margem de dois processadores lógicos informados pelo navegador sem teto fixo de quatro workers. Em dispositivos que informam dois processadores ou menos, ou não informam a contagem, usa um único worker; reservar dois nesses casos não é possível. Isso limita concorrência, sem reservar núcleos físicos ou garantir disponibilidade para outros aplicativos.

Cada iteração distribui os parciais por quantidade de pontos. O coordenador também calcula uma parte; os auxiliares calculam as demais com o mesmo resíduo. A reconstrução e a avaliação continuam sequenciais, e só depois começa a próxima iteração. Trabalhos pequenos usam o caminho sequencial. Depois do refino, esse grupo é encerrado e outro prepara as 88 notas em uma fila paralela. Todos os workers são terminados ao concluir, cancelar, trocar o timbre, alterar os parciais, falhar ou sair da página. A reprodução posterior usa apenas os áudios preparados e não mantém workers de cálculo.

## Envelope ADSR

Após salvar o instrumento, o bloco de parciais exibe à direita um gráfico ADSR. Arraste A para ajustar o ataque, D para decaimento e nível de sustentação, S para o nível de sustentação e R para o release. Os campos permitem valores precisos: ataque e decaimento de 0 a 5 s, sustentação de 0 a 100% e release de 0 a 10 s.

Os ajustes são salvos por instrumento ao concluir a edição e valem para as próximas notas do teclado/MIDI, sem recalcular o banco de áudio. Cada voz aplica o envelope ao volume existente do sample. Soltar a tecla inicia o release a partir do nível atual, mesmo durante ataque ou decaimento. O trecho horizontal S no gráfico é ilustrativo: sustenta enquanto a tecla está pressionada, limitado pelo fim do áudio. Não há loop nesta etapa. Notas no release contam no limite de 64 vozes; ao excedê-lo, uma voz em release é retirada primeiro.

## O que o protótipo faz

- Conversão para mono por média dos canais e reamostragem a 48 kHz.
- Análise STFT com janela Hann de 4096 amostras e salto de 256.
- Picos locais com interpolação parabólica logarítmica de amplitude/frequência.
- Limiar por frame: -65 dB relativos ao maior pico e piso de amplitude de 1e-5.
- Rastreamento entre frames consecutivos pela proximidade de frequência.
- Parciais válidos têm ao menos três frames e energia acumulada acima de 1e-9.
- Ordenação por energia com bônus harmônico de até 8%, orientado pela fundamental.
- Controle seleciona ceil(total × percentual), mínimo de um quando há parciais.
  100% inclui TODOS os parciais considerados válidos, sem limite fixo de quantidade.
  O total é de trajetórias ao longo do tempo, não de picos simultâneos por frame.
- Síntese com senoides, amplitude linear e fase cúbica, respeitando frequência/fase
  nos extremos. Rampas suavizam nascimento/morte de cada parcial e início/fim do áudio.
- Refinamento automático: até quatro iterações de ajuste local de amplitude e fase, mantendo frequências e número de trajetórias. Compara espectros em duas resoluções, energia por janela e forma de onda. Só aceita tentativas que reduzem o erro combinado. Cada seleção reinicia a partir da análise completa, evitando acumular os ajustes de seleções anteriores.
- O refinamento tem orçamento aproximado de 60 segundos; uma etapa de renderização ou comparação em andamento pode prolongá-lo. A preparação das notas ocorre depois e tem seu próprio custo. Trocar de timbre ou alterar os parciais cancela o trabalho anterior.
- Nas importações, o refinamento compara com o original. Ao salvar, a seleção se torna definitiva: somente as trajetórias refinadas escolhidas são guardadas. A análise inicial e as trajetórias excluídas são descartadas. Reabrir prepara as notas com 100% das trajetórias salvas, sem aplicar novamente o percentual escolhido. Para fazer outra seleção, importe um novo sample.
- Espectrograma logarítmico 20 Hz–20 kHz e até 80 trajetórias mais fortes desenhadas.
  Esse limite é apenas visual, não limita a reconstrução.

## Limites conhecidos

- Até 10 segundos por análise, escolhidos em qualquer posição do arquivo. A importação
  aceita até 512 MB; o navegador decodifica o arquivo completo na memória. A capacidade
  prática depende do dispositivo e do formato. Após preparar o trecho, o áudio completo
  é liberado. Para escolher outro trecho depois da análise, reimporte o arquivo.
- Quantidade total de parciais não tem teto artificial. Áudios ruidosos podem exigir
  muito tempo e memória; não há promessa de custo baixo para milhares de tracks.
- Não detecta automaticamente a fundamental. Ela é informada pelo usuário.
- Não recupera os osciladores físicos do instrumento, nem garante reconstrução
  perfeita. Não há camada residual de ruído. Transientes e graves muito baixos
  são limitados pela resolução da janela. O tracker pode juntar/separar trajetórias
  em cruzamentos; é um algoritmo simples de protótipo.
- Arquivos estéreo são somados em mono; canais em oposição de fase podem se cancelar.
- Não normaliza a entrada. A saída só é atenuada se o pico exceder 0,98; comparação
  auditiva não é normalizada por loudness. O volume controla apenas a reprodução.
- As 88 notas de piano (MIDI 21–108, Lá0–Dó8) são pré-geradas pelos parâmetros, preservando o número de amostras e os tempos das trajetórias. A reprodução usa velocidade 1. Segmentos acima do limite de Nyquist são omitidos nas notas transpostas. Todas as notas permanecem no cache do timbre ativo; mensagens MIDI fora dessa faixa são ignoradas. O teclado visual mantém uma região de 13 teclas. Trocar o timbre ou os parciais libera o cache. Para um trecho mono de 10 segundos a 48 kHz, os 88 buffers ocupam aproximadamente 169 MB (161 MiB), além dos parâmetros e demais buffers.
  Máximo de 64 vozes, sem sustain, pitch bend ou preservação independente da duração.
- Web MIDI depende do navegador e da permissão do usuário. Dispositivo físico não
  faz parte dos testes automatizados. O teclado virtual não exige dispositivo.

## Arquivos

- `index.html`: interface
- `styles.css`: estilos responsivos
- `app.js`: aplicação completa, FFT, análise, síntese, áudio e MIDI
- `server.cjs`: servidor local opcional, sem dependências, para Node.js
- `README.md`: instruções e limites

O `app.js` deve permanecer ao lado dos outros arquivos para usar esta interface.

## Verificação

Execute `node --test tests/smoothing.test.cjs`. Os testes verificam bypass em 0%,
redução de variações rápidas de amplitude, proteção de ataques, trajetórias curtas,
preservação da análise original e descarte de renderizações substituídas.

Execute também `node --test tests/instruments.test.cjs` para verificar o salvamento
por parâmetros, a liberação das referências ao original, falhas de armazenamento,
reabertura e exclusão. A liberação física de memória é gerenciada pelo navegador.

Execute também `node --test tests/deep.test.cjs` para verificar redução do erro, cancelamento, preservação de resultados exatos e reconstrução a partir dos parâmetros refinados. Para executar toda a suíte, use `node --test tests/*.test.cjs`.

O processamento reutiliza planos de FFT, janelas de ajuste e buffers espectrais, além de calcular as energias de referência uma vez por refino. A transposição usa buffers numéricos reutilizáveis e o transporte dos parâmetros entre workers usa Float64, sem reduzir a precisão. Pausas cooperativas são reguladas pelo tempo de processamento. Os pools usam no máximo a quantidade de tarefas disponíveis (88 na preparação das notas) e são encerrados ao concluir, cancelar ou trocar de timbre.

### Armazenamento compacto (versão 2)

Os parâmetros finais são um ArrayBuffer em little-endian: cabeçalho de 16 bytes (assinatura, versão do formato, comprimento do áudio e quantidade de trajetórias), seguido de uma contagem Uint32 por trajetória e pontos de 28 bytes (frame Uint32, frequência/amplitude/fase Float64). Não há redução de precisão dos valores de síntese nem compressão com perdas. Metadados de rastreamento, análise inicial e trajetórias não selecionadas não são armazenados. Os dados visuais e ADSR permanecem separados no registro IndexedDB. Instrumentos antigos continuam abrindo e são convertidos ao novo formato após preparar as notas; sua seleção também fica definitiva. Configurações inválidas ou incompatíveis são rejeitadas.

Validação: `node --test tests/*.test.cjs`, incluindo igualdade das amostras após codificar/decodificar, seleção sem aplicação duplicada, migração e bloqueio após salvar. No ensaio com cut.mp3 (1,921 s, C3, 100%), os parâmetros ocupam 2.413.352 bytes; o registro completo serializado em V8 ocupa cerca de 2,85 MB contra 12,95 MB anteriores. Isso mede a serialização, não o espaço exato do IndexedDB em disco.
