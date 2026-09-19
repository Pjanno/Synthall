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

1. Importe uma nota isolada ou clique em **Usar demonstração**.
2. Informe a fundamental manualmente. C4 = MIDI 60; C3 = MIDI 48.
3. Clique em **Analisar amostra** e aguarde a reconstrução.
4. Mova o controle de 25% a 100% e compare **Original** / **Resíntese**.
5. Toque no teclado virtual ou autorize **Conectar MIDI**.
6. **Baixar resíntese WAV** exporta o resultado mono, 48 kHz, PCM de 16 bits.

Todos os arquivos são processados localmente no navegador. Nenhum áudio é enviado.

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
- Worker mantém análise/síntese fora da interface. Alterar o controle reutiliza os
  tracks, mas exige renderizar um novo buffer; não é áudio espectral em tempo real.
- Espectrograma logarítmico 20 Hz–20 kHz e até 80 trajetórias mais fortes desenhadas.
  Esse limite é apenas visual, não limita a reconstrução.

## Limites conhecidos

- Até 15 segundos por análise; arquivos maiores são recortados nos primeiros 15 s
  com aviso. O tamanho do arquivo de entrada é limitado a 100 MB.
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
- MIDI e teclado virtual transpõem o buffer: notas agudas ficam mais curtas.
  Máximo de 8 vozes, sem sustain, pitch bend ou preservação independente da duração.
- Web MIDI depende do navegador e da permissão do usuário. Dispositivo físico não
  faz parte dos testes automatizados. O teclado virtual não exige dispositivo.

## Arquivos

- `index.html`: interface
- `styles.css`: estilos responsivos
- `app.js`: aplicação completa, FFT, análise, síntese, áudio e MIDI
- `server.cjs`: servidor local opcional, sem dependências, para Node.js
- `README.md`: instruções e limites

O `app.js` deve permanecer ao lado dos outros arquivos para usar esta interface.
