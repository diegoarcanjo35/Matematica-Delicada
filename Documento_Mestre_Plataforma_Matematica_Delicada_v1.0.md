# MATEMÁTICA DELICADA

# DOCUMENTO MESTRE DA PLATAFORMA

**Versão:** 1.0  
**Data:** 27 de agosto de 2026  
**Status:** especificação consolidada de produto, experiência, pedagogia e desenvolvimento  
**Responsável pelo produto:** Andreia Rodrigues  
**Natureza:** documento vivo

> **O contexto muda. O padrão se repete.**
>
> A Matemática Delicada prepara estudantes do Ensino Médio para aumentar seus acertos em Matemática no ENEM por meio do reconhecimento, treino e domínio dos padrões recorrentes da prova.

---

## 0. Finalidade e uso deste documento

Este Documento Mestre reúne as decisões tomadas sobre a Plataforma Matemática Delicada e deve funcionar como fonte principal para:

- orientar Claude, designers, desenvolvedores e fornecedores;
- preservar a metodologia própria da marca durante o desenvolvimento;
- impedir que a plataforma se transforme em um cursinho comum organizado apenas por assuntos;
- documentar telas, componentes, módulos, regras de negócio, métricas e prioridades;
- organizar a implantação por fases, do MVP às funções avançadas;
- registrar decisões futuras sem apagar o histórico do produto.

### 0.1 Regra de prevalência

Quando houver conflito entre uma decisão técnica e a proposta pedagógica, deve prevalecer a metodologia da Matemática Delicada: **os padrões recorrentes do ENEM são o eixo principal; os conteúdos tradicionais são suporte para dominar esses padrões**.

### 0.2 Controle de versões

| Versão | Data | Alteração |
|---|---|---|
| 0.1 | 27/08/2026 | Estrutura inicial com nove módulos básicos. |
| 0.2 | 27/08/2026 | Definição do público e inclusão do método por padrões recorrentes. |
| 1.0 | 27/08/2026 | Consolidação completa de metodologia, funcionalidades, layout, telas, regras, gestão, comercial e roadmap. |

---

# PARTE I — ESTRATÉGIA E IDENTIDADE DO PRODUTO

## 1. Identificação do produto

### 1.1 Nome

**Plataforma Matemática Delicada**

### 1.2 Categoria

Plataforma digital de preparação estratégica para Matemática no ENEM, com aprendizagem adaptativa, treinamento por padrões recorrentes, banco de questões, simulados, revisão espaçada e acompanhamento de desempenho.

### 1.3 Público principal

- estudantes do 1º, 2º e 3º anos do Ensino Médio;
- alunos que pretendem realizar o ENEM;
- estudantes com diferentes níveis de base matemática;
- alunos que precisam aumentar o número de acertos, reconhecer mais rapidamente as estruturas das questões e usar melhor o tempo de prova.

### 1.4 Perfis secundários

- professora/mentora responsável pela metodologia;
- professores e tutores autorizados;
- equipe pedagógica;
- administradores da operação;
- atendimento/suporte;
- equipe comercial, quando essa área for ativada;
- escolas ou parceiros, em uma futura modalidade institucional ou white-label.

### 1.5 Problema que a plataforma resolve

Muitos alunos estudam Matemática por uma lista extensa de assuntos, mas não aprendem a reconhecer como esses conteúdos aparecem no ENEM. Eles podem conhecer uma fórmula e ainda assim não identificar quando, por que e como usá-la.

A plataforma resolve esse problema ensinando o aluno a:

1. identificar as pistas do enunciado;
2. reconhecer o padrão recorrente;
3. selecionar a estratégia adequada;
4. resolver a questão;
5. analisar o erro ou o acerto;
6. revisar o padrão no momento certo;
7. comprovar domínio em novas questões com contextos diferentes.

### 1.6 Promessa central

O aluno não entra apenas para assistir aulas ou resolver listas. Ele recebe um caminho diário, aprende a decodificar questões do ENEM, ataca seus maiores gargalos e acompanha a evolução separada entre **reconhecer** e **resolver**.

### 1.7 Frases orientadoras da marca

- **O contexto muda. O padrão se repete.**
- **Reconheça antes de resolver.**
- **Você não precisa estudar tudo. Precisa estudar na ordem certa.**
- **Não é sobre estudar mais. É sobre estudar o que realmente importa.**
- **Foco hoje, vitória no ENEM.**

### 1.8 Princípios de experiência

1. **Clareza:** o próximo passo deve estar sempre evidente.
2. **Acolhimento:** linguagem próxima e delicada, sem infantilizar.
3. **Estratégia:** toda atividade precisa ter uma razão pedagógica.
4. **Personalização:** o percurso responde aos dados do aluno.
5. **Progresso visível:** a evolução precisa ser compreensível e motivadora.
6. **Rigor:** questões, gabaritos, métricas e explicações devem ser confiáveis.
7. **Ação:** dados devem indicar o que o aluno deve fazer em seguida.
8. **Foco no ENEM:** o produto não deve parecer um curso genérico de Matemática.

---

# PARTE II — METODOLOGIA MATEMÁTICA DELICADA

## 2. Eixo pedagógico: padrões recorrentes do ENEM

### 2.1 Definição de padrão

Um padrão é uma estrutura recorrente de raciocínio, leitura, modelagem ou resolução que aparece em diferentes questões do ENEM, ainda que o contexto, os números, as imagens ou o conteúdo superficial mudem.

### 2.2 Taxonomia

- O eixo inicial deverá trabalhar com **aproximadamente 20 padrões**.
- A quantidade não será rígida: a análise das provas pode resultar em 15, 18, 20, 25 ou mais padrões.
- A taxonomia deve ser revisável por edição do ENEM e por análise pedagógica.
- Cada questão pode possuir um padrão principal e padrões secundários.
- Assunto, habilidade, dificuldade e origem são dimensões complementares, não o eixo principal.
- Exemplos já usados no conceito visual: Razão em Gráfico, Escala, Porcentagem Direta, Mediana e Frequência e Projeção Ortogonal.
- A lista oficial e a definição de todos os padrões dependem da análise final do acervo de provas e materiais da Matemática Delicada.

### 2.3 Estrutura da ficha de cada padrão

Cada padrão deverá possuir uma página/ficha com:

- código, por exemplo `P03`;
- nome curto;
- frase de reconhecimento;
- descrição do padrão;
- pistas mais frequentes no enunciado;
- palavras e expressões recorrentes;
- elementos visuais recorrentes;
- estratégia principal;
- estratégias alternativas;
- conteúdos matemáticos necessários;
- pré-requisitos de base;
- erros e pegadinhas frequentes;
- exemplo introdutório;
- questões-modelo;
- vídeo ou aula relacionada;
- resumo estratégico;
- quantidade de questões disponíveis;
- nível atual do aluno;
- índice de reconhecimento;
- índice de resolução;
- índice de domínio;
- data da última prática;
- data sugerida para revisão;
- botão `Treinar este padrão`.

## 3. DNA da Questão

O **DNA da Questão** é a explicação estratégica que acompanha cada questão e diferencia a plataforma de um banco comum.

### 3.1 Componentes obrigatórios

| Componente | Função |
|---|---|
| Padrão | Identifica a estrutura recorrente principal. |
| Pista | Mostra o elemento do enunciado que permite reconhecer o padrão. |
| Estratégia | Explica o caminho mais eficiente antes dos cálculos. |
| Pegadinha | Alerta para o erro mais provável ou alternativa distratora. |
| Conteúdo de apoio | Indica o conhecimento matemático necessário. |
| Resolução | Apresenta o desenvolvimento passo a passo. |
| Atalho/macete | Exibe uma simplificação válida, quando existir. |
| Aprendizado do erro | Explica o que revisar se o aluno errou. |

### 3.2 Exibição em camadas

Para evitar que o aluno veja a resposta antes de pensar, a ajuda será progressiva:

1. **Camada 1 — pista leve:** destaca uma informação-chave.
2. **Camada 2 — reconheça o padrão:** lembra a estrutura sem dar a solução.
3. **Camada 3 — estratégia:** indica o caminho de resolução.
4. **Camada 4 — resolução comentada:** apresenta o passo a passo completo.

O sistema deve registrar quais camadas foram abertas. O uso frequente de ajuda reduz a evidência de domínio e alimenta o treino adaptativo.

## 4. Diagnóstico inicial

### 4.1 Objetivo

Descobrir o nível de base, a capacidade de reconhecer padrões e a capacidade de resolver questões antes de montar o primeiro plano de estudo.

### 4.2 Configuração inicial

- entre 12 e 20 questões;
- mistura de padrões, conteúdos e dificuldades;
- perguntas de reconhecimento antes ou durante parte das resoluções;
- tempo registrado, mas sem pressão excessiva no primeiro contato;
- possibilidade de sinalizar `não sei por onde começar`;
- resultado apresentado de forma acolhedora, sem rótulo negativo.

### 4.3 Resultados do diagnóstico

- nível de base matemática;
- padrões já reconhecidos;
- padrões reconhecidos, mas não resolvidos;
- padrões não reconhecidos;
- conteúdos de base frágeis;
- tempo médio;
- índice inicial de reconhecimento;
- índice inicial de resolução;
- primeiros gargalos;
- plano de treino inicial.

## 5. Três índices pedagógicos

### 5.1 Índice de Reconhecimento

Mede se o aluno identifica corretamente o padrão ou a estratégia antes de resolver.

Entradas sugeridas:

- acerto na escolha do padrão;
- tempo para reconhecer;
- quantidade de pistas utilizadas;
- consistência em contextos diferentes;
- recência das evidências.

### 5.2 Índice de Resolução

Mede se o aluno chega à resposta correta depois de trabalhar a questão.

Entradas sugeridas:

- resposta correta;
- número de tentativas;
- tempo de resolução;
- uso de dicas;
- natureza do erro;
- dificuldade da questão.

### 5.3 Índice de Domínio

Combina reconhecimento, resolução, estabilidade e revisão.

O domínio não deve ser concedido por um único acerto. Deve exigir evidências em questões diferentes, baixa dependência de dicas e manutenção após revisão espaçada.

### 5.4 Estados visuais de um padrão

| Estado | Significado |
|---|---|
| Não iniciado | Ainda não há evidências suficientes. |
| Muito frágil | Baixo reconhecimento e/ou baixa resolução. |
| Prioridade alta | Gargalo relevante para o desempenho. |
| Em evolução | Há progresso, mas falta estabilidade. |
| Quase dominado | Bom desempenho; necessita confirmação/revisão. |
| Dominado | Evidência consistente e recente. |
| Revisão vencida | Já foi dominado, mas precisa ser retomado. |

## 6. Treino diário adaptativo

### 6.1 Objetivo

Entregar todos os dias uma sessão curta e estratégica, dizendo exatamente o que o aluno deve fazer.

### 6.2 Variáveis de composição

- maior deficiência de reconhecimento;
- maior deficiência de resolução;
- erros recentes;
- revisões vencidas;
- padrões nunca treinados;
- conteúdos de base necessários;
- tempo disponível informado pelo aluno;
- meta de acertos;
- proximidade do ENEM;
- equilíbrio entre confiança e desafio;
- repetição excessiva do mesmo padrão;
- atividades obrigatórias atribuídas pelo professor.

### 6.3 Exemplo de sessão

**Treino de hoje — 7 questões — aproximadamente 18 minutos**

- Razão em Gráfico: 3 questões;
- Escala: 2 questões;
- Porcentagem Direta: 1 questão;
- Revisão espaçada: 1 questão.

Mensagem: **Hoje vamos atacar justamente o que ainda está roubando seus pontos.**

### 6.4 Modos do treino

1. **Modo Aprendizagem:** permite pistas em camadas, DNA da Questão e feedback imediato.
2. **Modo Reconhecimento:** pergunta primeiro qual é o padrão/estratégia, podendo encerrar antes da resolução em atividades específicas.
3. **Modo Prática:** resolução completa com ajuda limitada.
4. **Modo Revisão:** retoma erros e padrões na data calculada.
5. **Modo Prova:** sem dicas e com correção ao final.

### 6.5 Reagendamento

- atividade não realizada volta para a fila;
- o sistema não deve acumular uma carga impossível;
- prioridades são recalculadas;
- itens obrigatórios do professor precisam respeitar prazo e regras próprias;
- o aluno pode informar indisponibilidade e alterar sua rotina.

## 7. Caderno de Erros

### 7.1 Registro automático

Toda questão errada deve gerar um registro com:

- questão e resposta marcada;
- resposta correta;
- padrão principal;
- conteúdo;
- tipo de erro;
- data e tempo gasto;
- pistas utilizadas;
- explicação/DNA;
- anotação do aluno;
- status da revisão.

### 7.2 Tipos de erro

- não reconheceu o padrão;
- reconheceu o padrão errado;
- escolheu estratégia inadequada;
- erro de interpretação;
- erro de conteúdo/base;
- erro de cálculo;
- erro por pressa;
- falta de tempo;
- marcou alternativa incorreta apesar do raciocínio correto;
- tipo personalizado pelo professor.

### 7.3 Ciclo de correção

1. compreender o erro;
2. classificar o erro;
3. registrar aprendizado em uma frase;
4. resolver questão semelhante;
5. programar revisão;
6. comprovar correção do padrão em outro contexto.

---

# PARTE III — ARQUITETURA FUNCIONAL

## 8. Inventário consolidado de funcionalidades

| Nº | Funcionalidade | Fase sugerida |
|---:|---|---|
| 1 | Cadastro, login e recuperação de acesso | MVP |
| 2 | Onboarding e definição de meta | MVP |
| 3 | Diagnóstico inicial de 12–20 questões | MVP |
| 4 | Cronograma adaptativo | MVP |
| 5 | Treino diário por padrões | MVP |
| 6 | Taxonomia e fichas de padrões ENEM | MVP |
| 7 | Reconheça o Padrão | MVP |
| 8 | DNA da Questão e dicas em camadas | MVP |
| 9 | Conteúdos de base paralelos | MVP |
| 10 | Banco de questões ENEM e autorais | MVP |
| 11 | Filtros multidimensionais | MVP |
| 12 | Cadastro e importação em lote | MVP |
| 13 | Correção automática e feedback | MVP |
| 14 | Caderno de Erros | MVP |
| 15 | Revisão espaçada | MVP |
| 16 | Listas e atividades | MVP |
| 17 | Quatro simulados programados | Fase II |
| 18 | Métricas de reconhecimento, resolução e domínio | MVP |
| 19 | Dashboard/Mapa ENEM do aluno | MVP |
| 20 | Dashboard do professor | MVP |
| 21 | Administração de usuários e permissões | MVP |
| 22 | Turmas e acompanhamento individual | MVP/Fase II |
| 23 | Aulas gravadas | Fase II |
| 24 | Lives/aulas ao vivo | Fase II |
| 25 | Vídeos curtos e resumos estratégicos | Fase II |
| 26 | Comunicados e avisos | Fase II |
| 27 | Gamificação e conquistas | Fase II |
| 28 | Certificados | Fase III |
| 29 | Relatórios e exportações | Fase II |
| 30 | IA para recomendações e apoio editorial | Fase IV |
| 31 | Planos, checkout e vendas | Fase III |
| 32 | Funil de matrícula | Fase III |
| 33 | Cupons e campanhas | Fase III |
| 34 | Anúncios/rastreamento de campanhas | Fase III |
| 35 | Pagamentos, conciliação e antifraude | Fase III |
| 36 | Integrações externas e APIs | Fase III/IV |
| 37 | Domínio e páginas públicas | Fase III |
| 38 | Central de suporte | Fase II |
| 39 | White-label/licenciamento institucional | Fase V |
| 40 | Auditoria, logs e rastreabilidade | MVP |
| 41 | Acessibilidade e responsividade | MVP |
| 42 | Configurações, backups e operação | MVP |

## 9. Perfis e permissões

### 9.1 Aluno

Pode acessar seus próprios dados, realizar atividades, ver resultados liberados, editar preferências pessoais, registrar anotações e utilizar os recursos incluídos em seu plano.

Não pode alterar gabaritos, métricas, regras de atividades, dados de outros usuários ou classificações editoriais.

### 9.2 Professor/Mentor

Pode:

- gerenciar turmas autorizadas;
- visualizar alunos e evolução;
- atribuir atividades e prazos;
- montar listas e simulados;
- filtrar banco de questões;
- acompanhar padrões frágeis;
- inserir observações;
- liberar conteúdos e resultados;
- exportar relatórios permitidos.

### 9.3 Editor pedagógico

Pode cadastrar, importar, revisar, classificar e publicar questões, padrões, conteúdos, aulas, resumos e explicações.

### 9.4 Administrador

Pode gerenciar usuários, papéis, permissões, produtos, planos, turmas, bancos, integrações, comunicações, configurações e auditoria.

### 9.5 Suporte

Acesso limitado aos dados necessários para atendimento, com registro de toda consulta ou alteração.

### 9.6 Comercial

Acesso a leads, pedidos, planos, cupons e indicadores comerciais, sem acesso desnecessário a respostas e dados pedagógicos sensíveis.

## 10. Cadastro, login e onboarding

### 10.1 Entrada

- cadastro por nome, e-mail e senha;
- aceite de termos e política de privacidade;
- recuperação de senha;
- confirmação de e-mail;
- opção futura de login social;
- consentimento do responsável quando legalmente necessário.

### 10.2 Perguntas do onboarding

- série atual;
- ano em que fará o ENEM;
- meta de acertos ou nota;
- quantidade atual aproximada de acertos;
- dias disponíveis;
- minutos por dia;
- principais dificuldades percebidas;
- preferência de horário;
- necessidade de acessibilidade;
- realização do diagnóstico agora ou depois.

## 11. Cronograma adaptativo

### 11.1 Visualizações

- Hoje;
- Semana;
- Calendário mensal;
- Pendências;
- Revisões;
- atividades atribuídas;
- histórico concluído.

### 11.2 Tipos de atividade

- diagnóstico;
- reconhecimento;
- estudo de padrão;
- conteúdo de base;
- aula/vídeo;
- treino de questões;
- correção de erro;
- revisão espaçada;
- lista do professor;
- simulado;
- live;
- leitura de resumo.

### 11.3 Estados

`não iniciada`, `em andamento`, `concluída`, `atrasada`, `reagendada`, `dispensada`, `bloqueada`.

### 11.4 Regras mínimas

- toda atividade deve ter objetivo, estimativa de tempo e critério de conclusão;
- conclusão automática para questões e vídeos quando houver evidência suficiente;
- conclusão manual permitida somente onde fizer sentido;
- atrasos não podem gerar cronograma inviável;
- revisões críticas têm prioridade;
- o aluno deve entender por que uma atividade foi recomendada.

## 12. Banco de questões

### 12.1 Tipos de questão

- questões oficiais do ENEM, conforme disponibilidade e direitos de uso;
- questões autorais Matemática Delicada;
- questões licenciadas;
- questões de diagnóstico;
- questões exclusivas de reconhecimento;
- questões de revisão e recuperação de base.

### 12.2 Campos obrigatórios

- identificador;
- enunciado;
- imagens e texto alternativo;
- alternativas A–E;
- gabarito;
- resolução comentada;
- padrão principal;
- padrões secundários;
- pista, estratégia e pegadinha;
- conteúdo e subconteúdo;
- habilidade/competência;
- dificuldade;
- origem, prova e ano;
- tempo estimado;
- tipo de cálculo;
- necessidade de calculadora, se aplicável;
- tags;
- status editorial;
- autor e revisor;
- direitos/licença;
- data de criação e atualização.

### 12.3 Status editorial

`rascunho`, `em revisão`, `correção solicitada`, `aprovada`, `publicada`, `arquivada`.

### 12.4 Filtros

- padrão;
- conteúdo/subconteúdo;
- habilidade;
- dificuldade;
- oficial/autoral/licenciada;
- ano e prova;
- questão com imagem;
- questão já utilizada;
- taxa de acerto;
- tempo médio;
- qualidade/revisão;
- estado de domínio do aluno;
- erro anterior;
- revisão vencida;
- faixa de reconhecimento;
- faixa de resolução.

### 12.5 Importação

- planilha-modelo;
- importação unitária e em lote;
- pré-visualização;
- validação de campos;
- identificação de duplicidade;
- relatório de erros;
- upload de imagens;
- salvamento como rascunho;
- aprovação antes da publicação;
- histórico da importação e possibilidade de desfazer lote antes da publicação.

## 13. Player de questão

### 13.1 Estrutura

- cabeçalho com modo, progresso e tempo;
- enunciado e imagem;
- alternativas grandes e acessíveis;
- ação `não sei por onde começar`;
- botão de pista, quando permitido;
- salvar para revisar;
- denunciar problema;
- responder/confirmar;
- feedback;
- DNA da Questão;
- próxima questão.

### 13.2 Etapa de reconhecimento

Quando o modo exigir, antes das alternativas da questão o aluno responde:

- qual padrão aparece;
- qual pista levou a essa escolha;
- qual estratégia parece mais adequada.

### 13.3 Correção

- feedback imediato nos modos de aprendizagem/prática;
- feedback ao final no modo prova;
- mostrar resposta escolhida e correta;
- explicar por que a alternativa correta funciona;
- quando possível, explicar os distratores;
- classificar o erro;
- incluir automaticamente no Caderno de Erros;
- oferecer questão semelhante ou revisão de base.

## 14. Listas, atividades e simulados

### 14.1 Listas

- seleção manual ou automática;
- filtros salvos;
- título, instruções e objetivo;
- quantidade e ordem;
- embaralhamento;
- prazo e janela de acesso;
- limite de tentativas;
- correção imediata ou posterior;
- aplicação individual, por turma ou por grupo;
- nota ou caráter formativo;
- liberação programada do gabarito.

### 14.2 Quatro simulados programados

O produto deverá prever quatro grandes simulados durante o ciclo de preparação. A nomenclatura e o calendário final são decisões pedagógicas pendentes.

Estrutura sugerida:

1. simulado diagnóstico;
2. simulado de evolução intermediária;
3. simulado de consolidação;
4. simulado final.

Cada simulado deve registrar:

- acertos;
- tempo total e por questão;
- padrões reconhecidos e não reconhecidos;
- padrões resolvidos e não resolvidos;
- desempenho por dificuldade;
- erros por tipo;
- comparação com simulados anteriores;
- recomendações para o próximo ciclo.

**Decisão pendente:** uso de estimativa TRI. Não apresentar uma “nota TRI oficial” sem modelo validado e comunicação transparente de que se trata de estimativa.

## 15. Aulas, vídeos, lives e resumos

### 15.1 Biblioteca

- aulas completas;
- vídeos curtos;
- estratégias de prova;
- conteúdos de base;
- fichas e resumos;
- correções de simulados;
- lives gravadas;
- materiais complementares.

### 15.2 Metadados

- título;
- professor;
- duração;
- padrão relacionado;
- conteúdo;
- nível;
- material anexado;
- legenda/transcrição;
- progresso;
- data de publicação;
- plano necessário.

### 15.3 Lives

- agenda;
- página da transmissão;
- lembrete;
- link externo ou integração futura;
- presença;
- gravação posterior;
- materiais;
- perguntas, se houver moderação.

## 16. Comunicação

- avisos gerais;
- comunicados por turma;
- lembretes de atividade;
- lembretes de live;
- liberação de simulado;
- mensagem de revisão vencida;
- marcos de progresso;
- notificações internas;
- e-mail, conforme consentimento;
- push em fase posterior.

O aluno deve controlar preferências, exceto comunicações operacionais indispensáveis.

## 17. Gamificação com propósito

### 17.1 Elementos

- sequência de dias;
- padrões dominados;
- conquistas por consistência;
- conquistas por correção de erros;
- metas semanais;
- evolução de reconhecimento;
- evolução de resolução;
- conclusão dos quatro simulados;
- selos especiais;
- certificados em fase posterior.

### 17.2 Restrições

- não premiar resolução aleatória em volume;
- não estimular comparação tóxica;
- não esconder dificuldades com mensagens artificiais;
- recompensar consistência, reflexão, revisão e progresso real;
- rankings, se existirem, devem ser opcionais e cuidadosamente segmentados.

## 18. Dashboards e relatórios

### 18.1 Métricas do aluno

- padrões dominados;
- reconhecimento geral e por padrão;
- resolução geral e por padrão;
- domínio;
- acertos;
- tempo médio;
- sequência de dias;
- atividades concluídas;
- evolução semanal;
- maior gargalo;
- revisões pendentes;
- desempenho em simulados;
- meta e projeção de evolução, sem promessas enganosas.

### 18.2 Dashboard do professor

- alunos ativos e inativos;
- conclusão de atividades;
- desempenho da turma;
- padrões mais frágeis;
- reconhecimento × resolução;
- alunos com queda de atividade;
- alunos com revisões atrasadas;
- tempo de estudo;
- listas/simulados recentes;
- alertas e recomendações;
- acesso ao perfil individual.

### 18.3 Relatórios

- aluno individual;
- turma;
- padrão;
- conteúdo;
- atividade/lista;
- simulado;
- engajamento;
- evolução por período;
- uso de dicas;
- tipos de erro;
- exportação em PDF/CSV conforme permissão;
- agendamento futuro de envio.

## 19. Inteligência artificial — fase posterior

Usos permitidos após validação:

- apoiar recomendação de treino;
- sugerir classificação editorial, sempre com revisão humana;
- identificar padrões de dificuldade;
- resumir relatórios;
- sugerir explicações alternativas;
- auxiliar busca semântica no banco;
- apoiar atendimento.

Restrições:

- não publicar questão, gabarito ou resolução automaticamente sem revisão;
- não tomar decisões pedagógicas críticas sem explicação;
- não expor dados pessoais desnecessários;
- registrar quando uma saída foi gerada ou apoiada por IA;
- permitir auditoria e correção humana.

---

# PARTE IV — LAYOUT E EXPERIÊNCIA VISUAL

## 20. Conceito visual

### 20.1 Direção

**Caderno Estratégico ENEM:** aproximadamente 80% interface profissional de desempenho e 20% caderno/lettering.

A plataforma deve transmitir método, estratégia, acolhimento e alto desempenho. Não deve parecer infantil, excessivamente romântica ou um cursinho genérico.

### 20.2 Paleta principal

| Uso | Cor |
|---|---|
| Navy profundo | `#081C36` |
| Navy médio | `#102A4C` |
| Azul de ação | `#163F72` |
| Amarelo de destaque | `#F5B800` |
| Laranja estratégico | `#F28C00` |
| Branco | `#FFFFFF` |
| Papel claro | `#FFFDF8` |
| Fundo suave | `#FAF8F3` |
| Rosa da marca | `#F3A7BB` |
| Rosa claro de apoio | `#F9DDE5` |
| Verde marca-texto | `#B7E97A` |
| Azul claro de apoio | `#CFE9F4` |
| Sucesso | `#4FAE77` |
| Erro | `#D95B65` |
| Texto secundário | `#5F6670` |

**Restrição:** rosa-bebê não pode ser a cor predominante. Navy e branco sustentam a interface; rosa, amarelo, verde e azul claro atuam como destaques.

### 20.3 Tipografia

- títulos de impacto: Bebas Neue ou Oswald;
- interface e textos: Inter, Manrope ou DM Sans;
- manuscrita: Caveat ou Kalam, somente em anotações, destaques e frases curtas;
- não usar fonte manuscrita em textos longos, tabelas, botões críticos ou dados.

### 20.4 Elementos visuais

- cards arredondados;
- sombras leves;
- barras de progresso;
- gráficos de rosca, linha e barras;
- marca-texto;
- pequenos doodles de coração, estrela e seta;
- notas manuscritas pontuais;
- textura leve de papel/caderno em áreas especiais;
- ícones simples e consistentes;
- bastante respiro visual.

### 20.5 Grid e responsividade

- desktop: sidebar fixa + área principal em grid de 12 colunas;
- tablet: sidebar recolhível e cards em duas colunas;
- celular: navegação inferior ou menu compacto, cards em uma coluna;
- largura de conteúdo controlada para leitura;
- botões principais com altura mínima acessível;
- gráficos devem possuir alternativa textual;
- nenhuma informação pode depender somente de cor.

## 21. Navegação do aluno

### 21.1 Menu lateral desktop

1. Início
2. Treino Diário
3. Padrões ENEM
4. Reconheça o Padrão
5. Banco de Questões
6. Simulados
7. Caderno de Erros
8. Desempenho
9. Aulas e Estratégias
10. Conquistas

Itens complementares no perfil:

- notificações;
- ajuda/suporte;
- configurações;
- assinatura/plano;
- sair.

### 21.2 Navegação móvel

Barra inferior recomendada:

- Início;
- Treino;
- Padrões;
- Erros;
- Menu.

## 22. Tela Início — Dashboard do aluno

### 22.1 Cabeçalho

- saudação: `Boa tarde, Ana Cláudia! ♡`;
- frase: `Foco hoje, vitória no ENEM`;
- contagem regressiva configurável para o ENEM;
- sequência atual, por exemplo `12 dias`;
- notificações e perfil/plano.

### 22.2 Primeira dobra

#### Card Seu Mapa ENEM

- exemplo: `12/20 padrões dominados`;
- percentual geral, exemplo `60%`;
- mini-indicador de progresso;
- reconhecimento, exemplo `78% — Muito bom!`;
- resolução, exemplo `71% — Vamos evoluir!`;
- botão `Ver mapa completo`.

#### Card Treino de Hoje

- quantidade de questões;
- tempo aproximado;
- padrões selecionados;
- item de revisão espaçada;
- mensagem estratégica;
- botão principal `COMEÇAR TREINO`;
- opção de ajustar tempo disponível.

#### Card Seu Maior Gargalo

- nome e código do padrão;
- domínio atual;
- causa resumida: reconhecimento, resolução ou ambos;
- recomendação;
- botão `TREINAR AGORA`.

#### Card Evolução da Semana

- gráfico de segunda a domingo;
- variação percentual;
- sessões realizadas;
- comparação com semana anterior;
- texto alternativo do gráfico.

### 22.3 Segunda dobra

- mapa resumido dos padrões;
- próximos compromissos;
- erros para revisar;
- aula ou estratégia recomendada;
- conquistas recentes;
- último simulado;
- comunicados.

### 22.4 Exemplos de cards de padrão

| Padrão | Domínio | Reconhecimento | Resolução | Estado |
|---|---:|---:|---:|---|
| P03 Razão em Gráfico | 42% | 61% | 35% | Prioridade alta |
| P08 Porcentagem Direta | 91% | 94% | 88% | Dominado |
| P12 Escala | 67% | 72% | 61% | Em evolução |
| P15 Mediana e Frequência | 48% | 52% | 43% | Prioridade alta |
| P18 Projeção Ortogonal | 30% | 42% | 21% | Muito frágil |

## 23. Tela Treino Diário

### 23.1 Antes de começar

- objetivo do dia;
- justificativa da seleção;
- questões e tempo estimado;
- padrões trabalhados;
- modo de treino;
- ajustes permitidos;
- botão começar.

### 23.2 Durante

- progresso;
- tempo;
- questão;
- reconhecimento, quando aplicável;
- pistas em camadas;
- pausa segura;
- acessibilidade;
- confirmação antes de avançar.

### 23.3 Encerramento

- resumo de acertos;
- reconhecimento × resolução;
- padrões fortalecidos;
- erros registrados;
- tempo;
- próxima revisão;
- mensagem curta e honesta;
- ação recomendada.

## 24. Tela Padrões ENEM

- título `MAPA DOS PADRÕES`;
- busca e filtros por estado;
- cards com código, nome e três índices;
- estado visual;
- última prática;
- revisão prevista;
- ordenação por prioridade ou progresso;
- acesso à ficha completa;
- botão `Ver todos os padrões →` quando exibida no dashboard.

## 25. Tela Reconheça o Padrão

- desafio rápido;
- enunciado ou fragmento;
- alternativas com nomes de padrões;
- opção `ainda não reconheço`;
- confirmação;
- pista destacada depois da resposta;
- explicação com DNA ENEM;
- sequência curta de desafios;
- placar de reconhecimento sem misturar com resolução.

## 26. Tela Caderno de Erros

- filtros por padrão, erro, data, status e revisão;
- cards das questões erradas;
- anotação do aluno;
- DNA da Questão;
- botão `Corrigir meu erro`;
- agenda de revisão;
- indicador de erros corrigidos;
- comparação entre erro original e nova tentativa.

## 27. Tela Desempenho

- visão geral;
- reconhecimento;
- resolução;
- domínio;
- acertos por padrão;
- tempo médio;
- evolução semanal e mensal;
- histórico de simulados;
- tipos de erro;
- uso de dicas;
- consistência;
- recomendações acionáveis;
- filtros por período.

## 28. Tela Aulas e Estratégias

- destaques;
- continuar assistindo;
- filtros por padrão, conteúdo e duração;
- aulas completas;
- vídeos rápidos;
- lives;
- resumos;
- materiais anexos;
- progresso e favoritos.

## 29. Tela Conquistas

- sequência atual e recorde;
- padrões dominados;
- metas semanais;
- selos;
- histórico;
- próximos marcos;
- certificados liberados, quando ativados;
- explicação do mérito pedagógico de cada conquista.

## 30. Layout do professor

### 30.1 Menu

- Visão Geral;
- Alunos;
- Turmas;
- Atividades;
- Banco de Questões;
- Listas;
- Simulados;
- Conteúdos/Aulas;
- Relatórios;
- Comunicados;
- Configurações.

### 30.2 Tela inicial

- turmas ativas;
- alunos que precisam de atenção;
- padrões mais frágeis;
- atividades com prazo;
- evolução média;
- reconhecimento × resolução;
- atalhos para criar lista, comunicado ou simulado.

## 31. Layout administrativo

### 31.1 Menu

- Painel;
- Usuários;
- Papéis e permissões;
- Turmas e cursos;
- Padrões;
- Questões;
- Importações;
- Conteúdos;
- Produtos e planos;
- Vendas;
- Cupons;
- Comunicações;
- Relatórios;
- Integrações;
- Suporte;
- Auditoria;
- Configurações.

### 31.2 Princípios

- operações destrutivas exigem confirmação;
- mudanças críticas geram log;
- tabelas com busca, filtro, ordenação e paginação;
- ações em lote com resumo antes da execução;
- permissões aplicadas na interface e no servidor;
- dados pessoais visíveis somente quando necessários.

---

# PARTE V — ADMINISTRAÇÃO, COMERCIAL E OPERAÇÃO

## 32. Usuários, turmas e cursos

- cadastro individual e em lote;
- convite por e-mail;
- matrícula em curso/turma;
- status ativo, convidado, suspenso e arquivado;
- alteração de turma;
- histórico preservado;
- professor responsável;
- datas de acesso;
- plano/assinatura;
- acompanhamento individual;
- observações internas com permissão;
- importação/exportação controlada.

## 33. Produtos, planos e vendas

### 33.1 Estrutura futura

- produto;
- plano;
- mensal, trimestral, anual ou acesso por período;
- período de teste, se aprovado;
- conteúdo incluído;
- limites;
- preço e condições;
- cupom;
- checkout;
- pedido;
- pagamento;
- renovação;
- cancelamento;
- inadimplência;
- reembolso conforme política.

### 33.2 Funil

- visitante;
- lead;
- cadastro iniciado;
- diagnóstico iniciado;
- checkout iniciado;
- compra aprovada;
- aluno ativo;
- renovação;
- cancelamento.

### 33.3 Campanhas e anúncios

- origem/UTM;
- campanha;
- página de entrada;
- conversão;
- cupom;
- custo importado ou integrado;
- consentimento e regras de privacidade;
- integração futura com plataformas de anúncios.

### 33.4 Antifraude

- integração com provedor de pagamento;
- análise feita pelo provedor especializado;
- registro de status e motivo permitido;
- revisão manual quando aplicável;
- nunca armazenar dados completos de cartão na plataforma.

## 34. Suporte

- central de ajuda;
- perguntas frequentes;
- abertura de chamado;
- categoria e prioridade;
- anexos;
- histórico;
- responsável;
- status;
- prazo de resposta;
- vínculo opcional com usuário, pagamento, questão ou atividade;
- acesso auditado;
- avaliação do atendimento.

## 35. White-label — fase futura

Possibilidade de licenciamento para escolas ou parceiros com:

- logotipo e cores;
- domínio/subdomínio;
- turmas próprias;
- usuários segregados;
- relatórios institucionais;
- configurações limitadas;
- termos e contratos específicos.

**Restrição:** não implementar antes de a versão principal estar estável, pois aumenta significativamente a complexidade de permissões, dados e suporte.

---

# PARTE VI — REGRAS TÉCNICAS E DE DADOS

## 36. Entidades principais do modelo de dados

| Entidade | Finalidade |
|---|---|
| Usuário | Identidade e acesso. |
| Perfil | Dados específicos de aluno/professor/admin. |
| Papel/Permissão | Autorização. |
| Plano/Assinatura | Acesso comercial. |
| Turma/Curso | Organização pedagógica. |
| Padrão | Taxonomia principal. |
| Conteúdo/Habilidade | Dimensões complementares. |
| Questão/Alternativa | Banco de exercícios. |
| DNA da Questão | Pista, estratégia, pegadinha e resolução. |
| Tentativa/Resposta | Evidência de aprendizagem. |
| Reconhecimento | Escolha do padrão antes da resolução. |
| Erro/Revisão | Caderno de Erros e espaçamento. |
| Atividade/Cronograma | Plano diário e atribuições. |
| Lista/Simulado | Agrupamentos avaliativos. |
| Aula/Material/Live | Conteúdo pedagógico. |
| Métrica/Evento | Indicadores e telemetria. |
| Conquista/Certificado | Gamificação. |
| Comunicado/Notificação | Comunicação. |
| Pedido/Pagamento/Cupom | Comercial. |
| Chamado | Suporte. |
| Log de auditoria | Rastreabilidade. |

## 37. Eventos que devem ser registrados

- login e falha de login;
- início e conclusão de onboarding;
- início/conclusão de atividade;
- visualização e resposta de questão;
- padrão selecionado;
- pista aberta;
- resposta alterada;
- erro classificado;
- revisão concluída;
- vídeo iniciado/concluído;
- simulado iniciado/finalizado;
- mudança de cronograma;
- alteração editorial;
- importação;
- mudança de permissão;
- compra, renovação e cancelamento;
- ações administrativas críticas.

## 38. Segurança, privacidade e LGPD

- minimização de dados;
- base legal e consentimentos adequados;
- termos e política de privacidade;
- controle de acesso por papel;
- senhas protegidas por hash seguro;
- criptografia em trânsito;
- gestão de sessão;
- backups;
- registro de ações críticas;
- atendimento a solicitações do titular;
- política de retenção;
- separação entre ambientes;
- proteção especial para menores;
- contratos com fornecedores que tratam dados;
- plano de resposta a incidentes.

## 39. Acessibilidade

- conformidade progressiva com WCAG;
- navegação por teclado;
- foco visível;
- contraste suficiente;
- textos alternativos;
- legendas e transcrições;
- rótulos de campos;
- mensagens de erro compreensíveis;
- gráficos com resumo textual;
- não depender apenas de cor;
- zoom e responsividade;
- tempo ajustável quando a atividade não for avaliativa.

## 40. Desempenho e confiabilidade

- páginas principais rápidas em conexão móvel;
- carregamento progressivo de mídia;
- paginação de bancos e relatórios;
- salvamento de respostas durante simulados;
- retomada segura após interrupção;
- filas para importações e relatórios pesados;
- monitoramento de erros;
- disponibilidade e recuperação documentadas;
- ambientes de desenvolvimento, teste e produção;
- testes automatizados dos fluxos críticos.

## 41. Domínio, integrações e APIs

### 41.1 Integrações possíveis

- provedor de e-mail;
- pagamento;
- vídeo/transmissão;
- analytics;
- anúncios;
- atendimento;
- armazenamento;
- autenticação social;
- escolas e parceiros por API em fase futura.

### 41.2 Regras

- integrações devem ser desacopladas;
- credenciais nunca ficam no código;
- webhooks devem ser autenticados e idempotentes;
- falhas devem poder ser reprocessadas;
- consentimentos devem ser respeitados;
- toda integração crítica precisa de logs.

---

# PARTE VII — ROADMAP, CRITÉRIOS E GOVERNANÇA

## 42. Roadmap proposto

### Fase I — MVP pedagógico

- autenticação e onboarding;
- diagnóstico;
- padrões e fichas;
- banco/importação;
- player e correção;
- DNA da Questão;
- treino diário;
- cronograma;
- Caderno de Erros;
- revisão espaçada;
- métricas centrais;
- dashboards básicos;
- professor/admin essenciais;
- acessibilidade, segurança e logs mínimos.

### Fase II — experiência completa

- quatro simulados;
- turmas avançadas;
- aulas, vídeos e lives;
- comunicados;
- gamificação;
- relatórios/exportações;
- suporte estruturado;
- melhorias avançadas de dashboard.

### Fase III — comercial e crescimento

- produtos e planos;
- checkout e pagamentos;
- cupons;
- funil;
- campanhas/anúncios;
- antifraude;
- domínio e páginas públicas;
- integrações comerciais;
- certificados.

### Fase IV — inteligência e automação

- recomendações avançadas;
- IA com revisão humana;
- busca semântica;
- relatórios inteligentes;
- automações operacionais.

### Fase V — institucional

- licenciamento para escolas;
- white-label;
- APIs institucionais;
- relatórios por unidade;
- gestão multi-organização.

## 43. Critérios de sucesso do MVP

### 43.1 Produto

- aluno conclui onboarding e diagnóstico;
- recebe treino diário coerente;
- consegue reconhecer e resolver questões;
- erros alimentam revisões;
- progresso é atualizado;
- professor acompanha aluno;
- administrador mantém o acervo sem ação técnica direta.

### 43.2 Aprendizagem

- evolução do reconhecimento;
- evolução da resolução;
- redução de erros repetidos;
- aumento de padrões dominados;
- manutenção do domínio após revisão;
- melhora nos simulados.

### 43.3 Engajamento

- ativação após cadastro;
- conclusão do diagnóstico;
- realização do primeiro treino;
- retorno semanal;
- conclusão de treinos;
- sequência de estudo;
- uso do Caderno de Erros.

### 43.4 Qualidade

- taxa de questões denunciadas;
- erros de gabarito confirmados;
- falhas de importação;
- indisponibilidade;
- chamados por dificuldade de uso;
- acessibilidade dos fluxos críticos.

## 44. Critérios gerais de aceite

Uma funcionalidade só deve ser considerada pronta quando:

1. possui objetivo e regra documentados;
2. respeita permissões;
3. funciona no desktop e no celular;
4. possui estados de carregamento, vazio, sucesso e erro;
5. possui acessibilidade básica;
6. registra os eventos necessários;
7. foi testada com dados realistas;
8. não quebra o método por padrões;
9. apresenta texto revisado em português;
10. foi validada pedagogicamente quando afeta aprendizagem.

## 45. Decisões pendentes

Os pontos abaixo não foram fechados e não devem ser tratados como decisão definitiva:

- lista oficial e nomes de todos os padrões;
- fórmula exata dos três índices;
- calendário e nomenclatura dos quatro simulados;
- existência e método de estimativa TRI;
- modelo de negócio e preços;
- planos e limites;
- tecnologia e hospedagem;
- provedores de pagamento, vídeo, e-mail e analytics;
- regras de certificado;
- uso de ranking;
- política detalhada de cancelamento/reembolso;
- prazo de lançamento;
- momento de ativação de white-label.

## 46. Registro de decisões

| Data | Decisão | Responsável | Impacto |
|---|---|---|---|
| 27/08/2026 | Público: alunos do Ensino Médio que se preparam para o ENEM. | Andreia Rodrigues | Direciona metodologia, conteúdo e produto. |
| 27/08/2026 | Padrões recorrentes são o eixo; assuntos são suporte. | Andreia Rodrigues | Diferencia a plataforma de um cursinho tradicional. |
| 27/08/2026 | Identidade não terá predominância de rosa-bebê. | Andreia Rodrigues | Define direção visual profissional e acolhedora. |
| 27/08/2026 | Documento 1.0 incluirá decisões do chat normal e do Work. | Andreia Rodrigues | Consolida o projeto em uma única referência. |

## 47. Checklist de cobertura da versão 1.0

- [x] Público e posicionamento
- [x] Metodologia por padrões
- [x] Aproximadamente 20 padrões, sem número rígido
- [x] Ficha de reconhecimento
- [x] DNA da Questão
- [x] Diagnóstico de 12–20 questões
- [x] Reconhecimento, resolução e domínio
- [x] Treino adaptativo e modos de treino
- [x] Dicas em camadas
- [x] Caderno de Erros
- [x] Revisão espaçada
- [x] Cronograma
- [x] Banco, filtros e importação
- [x] Player e correção
- [x] Listas e quatro simulados
- [x] Dashboards e relatórios
- [x] Aulas, vídeos, lives e resumos
- [x] Comunicados
- [x] Gamificação e certificados
- [x] Professor, turmas e administração
- [x] IA posterior
- [x] Vendas, funil, cupons e anúncios
- [x] Pagamentos e antifraude
- [x] Integrações e domínio
- [x] Suporte
- [x] White-label
- [x] Layout, paleta, tipografia e responsividade
- [x] Telas e menus por perfil
- [x] Dados, segurança, LGPD e acessibilidade
- [x] Roadmap MVP–V
- [x] Critérios de aceite e sucesso
- [x] Decisões pendentes

---

## Encerramento

A Plataforma Matemática Delicada não deve ser construída como uma coleção de videoaulas seguida por um banco genérico de exercícios. Sua identidade nasce da capacidade de mostrar ao aluno que os contextos variam, mas as estruturas se repetem — e de transformar essa percepção em treino diário, correção inteligente, revisão e mais acertos no ENEM.

> **Não é sobre estudar mais. É sobre estudar o que realmente importa.**
