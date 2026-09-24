# Проверка интеллекта и майнинг NIR: от приложения до награды

Этот документ отвечает на практический вопрос: что произойдёт, если обычный
пользователь откроет Mac и захочет подключить модель или приложение к майнингу
NIR. Здесь намеренно разделены **реализованные правила прототипа** и
**планируемый пользовательский продукт**.

> **Короткий ответ на сегодня:** скачать «NIR Miner», выбрать приложение и
> начать реальный майнинг пока нельзя. В репозитории есть проверяемые форматы,
> локальный статический адаптер и консенсусные переходы, но нет публичной сети,
> установщика для macOS, очереди заданий, production sandbox/TEE, удалённого API
> операторов и доказанной независимости операторов. Локальный прогон сейчас —
> тест протокола без реальной награды.

## Что именно считается полезной работой

NIR не платит за запущенный вентилятор, количество GPU-часов или ответы на
задания, которые пользователь придумал сам. Кандидат должен показать новый
измеримый результат относительно уже известного мирового фронтира:

1. лучше пройти свежие задачи хотя бы в одной версионированной capability-семье;
2. не скрыть существенную регрессию относительно заявленных родителей;
3. воспроизвести результат у назначенных оценщиков;
4. пройти утверждённую политику безопасности;
5. связать результат с заранее зафиксированными байтами кандидата, baseline и
   средой выполнения;
6. пережить окно объективного оспаривания.

Обычный пользователь может быть автором небольшой модели, алгоритма,
инструмента или улучшения эффективности. Обычное использование ChatGPT,
локальной LLM или другого приложения не является майнингом само по себе.

## Как это должно выглядеть на Mac для пользователя

Ниже — целевой простой сценарий. Он **планируется**, но ещё не реализован как
готовое приложение.

1. Пользователь устанавливает подписанное приложение NIR, сверяет издателя,
   сеть и genesis fingerprint, затем создаёт кошелёк и резервную копию.
2. В разделе «Майнинг интеллекта» он нажимает «Добавить кандидата» и выбирает
   один способ подключения:
   - пакет модели/алгоритма на диске;
   - локальное приложение с NIR adapter;
   - удалённый API, доступный только из изолированного стенда оператора.
3. Приложение выполняет **локальную предварительную проверку**: совместимость
   адаптера, размер пакета, список файлов, отсутствие ссылок и специальных
   файлов, пробный публичный набор задач. Эта проверка ничего не майнит и не
   является официальной оценкой.
4. Пользователь видит до подписи: сеть, адрес получателя, baseline, родителей,
   commitment набора задач, хеши артефакта и канонического содержимого, размер
   bond, максимальный срок ожидания и риск полной потери bond при незавершённой
   уже назначенной проверке.
5. Сначала в отдельном финализированном блоке блокируется progress-bond. Затем
   подписывается `progress-commitment`. Это не передаёт приватный ключ модели и
   не раскрывает скрытые задания.
6. После commitment сеть получает свежую randomness от отдельного beacon
   committee и только затем назначает evaluator committee и challenge seed.
   Пользователь не выбирает оценщиков.
7. Пользователь передаёт пакет **не блокчейну**, а назначенным операторам по
   будущему защищённому submission API. Если используется удалённый API модели,
   передаётся одноразовый credential с минимальными правами, а не основной
   аккаунт или платёжный ключ.
8. Каждый оператор в своей изолированной среде запускает один и тот же baseline
   и candidate, с одинаковыми лимитами и свежими задачами. Интерфейс показывает
   статусы вроде «ожидает challenge», «2 из 3 воспроизведений», «safety veto» и
   «reward escrow», но не должен показывать скрытые ответы до завершения окна.
9. Если полный назначенный committee подписал один и тот же receipt, валидаторы
   пересчитывают метрики, frontier delta, score и распределение эпохи. Награда
   и возврат bond остаются неликвидными 64 финализированных блока.
10. После окна оспаривания кандидат входит в capability memory, награда и bond
    становятся доступными. Конфликтующий receipt, подписанный всем исходным
    committee, до unlock сжигает pending reward и bond и наказывает оценщиков.

Ни приложение, ни сайт оператора не должны просить seed-фразу кошелька. Ключ
кошелька подписывает только транзакции commitment/bond; credential приложения
и ключ модели должны быть отдельными и отзывными.

## Что реализовано сейчас

| Часть | Статус | Что действительно проверяется |
| --- | --- | --- |
| `nir-model-content-v1` | Реализовано | Ограниченная директория/tar, точный allowlist файлов, роли baseline/candidate, лимиты, защита от symlink/hardlink/path ambiguity и канонический `contentHash`. |
| `nir-static-eval-adapter-v1` | Реализован только как fixture | Читает неисполняемый JSON `answers`; не запускает модель, приложение или сеть. |
| Candidate commitment | Реализовано | Связывает сеть, отправителя/получателя, artifact/baseline/content hashes, родителей и suite commitment в `candidateId`. |
| Challenge и назначение committee | Реализовано в модели chain | Challenge появляется после финализированного commitment из beacon entropy; назначенный evaluator committee нельзя заменить произвольным quorum. |
| Light-client anchor assignment | Реализован exact path v27 и bounded checkpoint v28 | v26 добавляет `evaluationAssignmentRoot`; v27 фиксирует runner environment, safety, expiry, ключи и состав финализаторов. Assignment v2 + chain-proof v3 проверяет genesis→source→decision/inclusion. V28 добавляет подписанный свежий checkpoint с genesis hash и validator-set ID, поэтому длинная цепь проверяет только bounded suffix и всё равно возвращает `exactAssignmentIncluded=true`. Legacy-форматы не изменены. |
| Оценка | Реализована для точных текстовых ответов | Не менее трёх разных verifier IDs; один и тот же набор оценщиков для baseline/candidate; majority, family regression, reproducibility, safety и median energy. |
| Execution bundle | Реализовано | Связывает challenge, environment manifest, suite reveal, все ответы, content/entrypoint bindings, отчёт и `bundle_hash`. |
| Capability memory/frontier | Реализовано | Запрещает известный artifact/content/behavior, требует известных родителей и минимум 100 bps нового frontier gain. |
| Chain reward и escrow | Реализовано в прототипе | Проверяет admission, approved safety policy, frontier transition, committee signatures, score, supply cap, collateral ceiling и 64-блочный escrow. |
| Реальное исполнение модели | Частично: receipt есть, доверенной изоляции нет | Назначенные оценщики могут подписывать execution transcripts, а v27 receipt-путь требует matching exact chain anchor. Но production sandbox/TEE и аппаратная аттестация физического запуска ещё не реализованы. |
| Подключение локального приложения | Экспериментальный runner path реализован | `nir.application_adapter` запускает argv без shell, а `run_application_adapter()` связывает complete outputs с artifact/content/entrypoint, challenge, environment и создаёт `ExecutionTranscript`. `create_application_bundle()` принимает только такие transcripts. Это не sandbox/attestation и не активный chain adapter. |
| Подключение удалённого API | Не реализовано | Нет submission gateway, mTLS/одноразовых credentials или production egress policy. Контракт ниже — проектируемая граница. |
| Измерение энергии | Не реализовано как доверенное измерение | Experimental application runner принудительно записывает `energy_attested=false`, в том числе при повторной загрузке bundle. Поэтому его bundle заведомо не проходит production chain reward gate. |
| Независимость компаний | Не доказуема кодом | Уникальные ключи и operator IDs не доказывают разных владельцев, хостинг или отсутствие сговора. |
| Публичный майнинг и реальные NIR | Недоступно | Нет production/mainnet допуска; тестовые локальные сценарии не обещают доход. |

## Реальный текущий путь разработчика: data-only fixture

В прототипе «подключить модель» означает подготовить пакет, в котором
entrypoint уже содержит ответы. Это полезно для проверки commitments, но не для
доказательства интеллекта.

`nir-model-content.json`:

```json
{
  "entrypoint": {
    "adapter": "nir-static-eval-adapter-v1",
    "path": "answers.json"
  },
  "files": [
    { "executable": false, "path": "answers.json" },
    { "executable": false, "path": "weights.bin" }
  ],
  "format": "nir-model-content-v1",
  "role": "candidate"
}
```

`answers.json`:

```json
{
  "format": "nir-static-eval-adapter-v1",
  "answers": {
    "case-001": "42",
    "case-002": "refuse"
  }
}
```

`nir.model_content.inspect_model_content()` вычисляет `contentHash`, а
`nir.runner.read_static_model_content_receipt()` создаёт transcript. Создание
bundle с локальными путями ещё раз пересчитывает содержимое и сверяет ответы с
entrypoint. Импорт `nir.runner` не исполняет код кандидата. Официального CLI,
который превращает эти шаги в майнинг, сейчас нет.

## Планируемый контракт адаптера для моделей и приложений

Этот раздел — **экспериментальный API**, а не активный consensus format.
Локальный child-process transport реализован в `nir.application_adapter`;
`nir.runner.run_application_adapter()` детерминированно переводит его plain-text
outputs в `RunRecord`/`ExecutionTranscript`, а `create_application_bundle()` — в
существующий execution bundle. Это отдельный experimental adapter format:
remote transport, hardware attestation и production-изоляция ещё не реализованы.
Любой допуск в сеть требует тестовых векторов, версии consensus policy и
независимого аудита.

### Транспорт

Реализованный локальный транспорт — дочерний процесс и framed NDJSON через
`stdin/stdout`: приложение не открывает порт, а sandbox контролирует процесс.
Каждая строка — один UTF-8 JSON object, не более 16 MiB; неизвестные поля и
дублированные JSON-ключи отклоняются. `stderr` считается диагностикой и не
входит в ответ (текущая реализация отбрасывает его). Runner задаёт deadline и
после него завершает process group, сначала `SIGTERM`, затем `SIGKILL`, и удаляет
одноразовый рабочий каталог. Процесс запускается как argv с `shell=False`, в
новой session, с закрытыми лишними descriptors и минимальным environment.
Один deadline охватывает и неблокирующую запись request, и чтение response:
приложение, которое перестало читать `stdin`, не может подвесить runner.
Дополнительный environment ограничен 32 переменными/32 KiB и отклоняет имена,
похожие на password, passphrase, private, secret, token, key, mnemonic или seed;
credentials через этот API передавать нельзя.

Важно: process group и временный каталог — это очистка жизненного цикла, а не
изоляция. Вредоносный процесс на обычном пользовательском Mac всё ещё может
попытаться выйти из своей session или обратиться к доступным ОС-ресурсам.
Непроверенный adapter следует запускать только внутри отдельного sandbox/VM.

Для приложения, которое нельзя запустить дочерним процессом, будущий bridge
может использовать Unix domain socket внутри sandbox. Loopback TCP и удалённый
HTTPS требуют отдельного профиля политики, взаимной аутентификации и
одноразового credential. Они не получают доступ к кошельку NIR.

Минимальный вызов текущего transport из runner:

```python
from nir.application_adapter import ApplicationAdapter

with ApplicationAdapter(
    ["/usr/bin/python3", "-I", "/absolute/path/to/adapter.py", "--stdio"],
    measured_entrypoint="/absolute/path/to/adapter.py",
) as app:
    description = app.describe(challenge_seed)
    if description.model_identity != expected_model_identity:
        raise ValueError("committed model identity does not match")
    result = app.evaluate(
        case_id="opaque-7f3a",
        input_media_type="application/json",
        input_value={"messages": [{"role": "user", "content": "..."}]},
        seed=case_seed,
        timeout_ms=30_000,
    )
```

`model_identity` не считается самодоказательством. Production-oriented local
run требует явный `measured_entrypoint`: абсолютный regular file, который точно
один раз присутствует в argv после отдельного launcher. Он читается с запретом
final symlink, измеренные байты копируются в private file, открываются read-only,
pathname удаляется, а child получает вместо исходного пути только inherited
`/dev/fd` descriptor. Поэтому swap-and-restore исходного pathname между hash и
`Popen` не меняет исполняемые байты. Фактический SHA-256 должен совпасть с
pre-challenge `entrypoint_digest`; отсутствие measurement, подмена или попытка
передать measured file как `argv[0]` не создаёт transcript. До challenge функция
`application_content_hash()` связывает role, adapter, entrypoint path и
entrypoint digest в experimental `contentHash`, который входит в
`CandidateCommitment`. После reveal `run_application_adapter()` сверяет
handshake с этим заранее committed entrypoint digest. Он также требует exact
case set, `reset-per-case`, environment с
`adapter_protocol == nir-application-adapter-v1`, plain-text output и выводит
case seed из challenge, epoch, role, artifact/content и case ID. Любой timeout,
remote error, missing/extra case или неверный output завершает run без
`RunRecord`. `maxInputBytes` относится к канонической JSON-кодировке
`input.value`, а не ко всему request frame.

Текущий application bundle по-прежнему не доказывает физическое исполнение.
Локальный transport теперь descriptor-bound запускает snapshot одного
измеренного entrypoint, но не
все динамически загружаемые веса/библиотеки, состояние ОС или оборудование.
Поэтому этот путь
явно отделён от static fixture именем `nir-application-adapter-v1` и не должен
использоваться для production rewards до подписанной hardware attestation.
Переданное или подделанное `energy_attested=true` отклоняется при запуске,
сборке и загрузке application bundle.

### Handshake

Runner отправляет:

```json
{
  "format": "nir-application-adapter-v1",
  "method": "describe",
  "requestId": "r-01",
  "params": {
    "challengeSeed": "64-lowercase-hex",
    "protocolVersion": 1
  }
}
```

Adapter отвечает:

```json
{
  "format": "nir-application-adapter-v1",
  "requestId": "r-01",
  "result": {
    "capabilities": ["text"],
    "determinism": "seeded",
    "maxInputBytes": 1048576,
    "modelIdentity": "sha256:<64-lowercase-hex>",
    "statePolicy": "reset-per-case"
  }
}
```

`modelIdentity` должен быть связан с committed model content. Свободная строка
от приложения не является доказательством. Production runner обязан получить
эту связь из измеренного image/model digest или attestation.

### Один evaluation case

```json
{
  "format": "nir-application-adapter-v1",
  "method": "evaluate",
  "requestId": "r-02",
  "params": {
    "caseId": "opaque-7f3a",
    "input": {
      "mediaType": "application/json",
      "value": { "messages": [{ "role": "user", "content": "..." }] }
    },
    "seed": "64-lowercase-hex",
    "timeoutMs": 30000,
    "toolPolicy": "none"
  }
}
```

Успешный ответ:

```json
{
  "format": "nir-application-adapter-v1",
  "requestId": "r-02",
  "result": {
    "caseId": "opaque-7f3a",
    "output": { "mediaType": "text/plain", "value": "42" },
    "usage": { "inputTokens": 12, "outputTokens": 1 }
  }
}
```

Ошибка возвращается как `{"error":{"code":"TIMEOUT","message":"..."}}`
вместо `result`; неизвестный `requestId`, повторный ответ, лишний case или
пропущенный case делают run недействительным. Adapter не получает `expected`,
семейство, safety-флаг, score baseline или приватные ответы. Case ID непрозрачный.
Runner сам сортирует и канонизирует transcript; порядок ответов не влияет на
commitment.

### Контракт runner, который обязателен до production

Для каждого назначенного оценщика runner должен:

- получить finalized `candidateId`, challenge seed, suite commitment и policy
  hash непосредственно из собственного full node/light-client proof;
- проверить artifact/content hashes **внутри** изоляции до запуска;
- измерить весь разрешённый launch closure (entrypoint, веса, runtime и
  библиотеки), а не полагаться на self-declared model identity; локальная
  реализация пока fail-closed descriptor-bound связывает только один explicit
  entrypoint file после отдельного launcher;
- создать одноразовую чистую среду, read-only пакет, лимиты CPU/RAM/time/disk,
  новый профиль приложения и отдельное состояние на case;
- по умолчанию запретить сеть, host filesystem, буфер обмена, камеру, микрофон,
  keychain, GUI automation и произвольные tools; необходимые возможности
  выдавать только версионированной policy;
- одинаково запускать frozen baseline и candidate на одних case и лимитах;
- измерять полные outputs, exit status, timeout, resource/energy evidence и
  environment image/runner digests;
- подписывать transcript аппаратно защищённым evaluator key только после
  локальной повторной проверки bundle;
- уничтожать одноразовые credentials и рабочий каталог по окончании, сохраняя
  лишь предусмотренные retention policy commitments/evidence.

Для remote API дополнительно фиксируются endpoint policy hash, TLS identity,
request/response commitments и egress destination. Секрет API не попадает в
bundle или chain. Но такая запись всё равно доказывает лишь обращение к endpoint,
а не внутренние веса удалённой модели; для некоторых evaluation families этого
может быть недостаточно.

## Что создаётся на каждом шаге

| Шаг | Артефакт доказательства | Кто проверяет |
| --- | --- | --- |
| Упаковка | `artifactHash`, canonical `contentHash`, entrypoint digest/path | Пользователь локально; затем каждый runner |
| Admission | Подписанный `progress-commitment`, `candidateId`, parents, baseline pair, suite commitment | Валидаторы |
| Randomness | Beacon shares, aggregate и derived `challengeSeed` после commitment | Каждый full node |
| Исполнение | Baseline/candidate transcripts с environment hash, seed, outputs, energy fields | Сейчас локальный Python bundle; в production — независимые attested runners |
| Оценка | Accuracy, family deltas, gain, generality, reproducibility, safety, critical veto, median energy | Детерминированно evaluator code; валидаторы проверяют подписанный итог и chain bounds |
| Новизна | Behavior commitment, capability scores, frontier roots before/after, marginal gains | Capability memory в consensus |
| Receipt | `executionBundleHash`, fingerprint, score и подписи полного назначенного committee | Валидаторы |
| Settlement | Epoch allocation, pending reward/bond, unlock height | Consensus и account proofs |

`bundle_hash` связывает публичное содержимое execution bundle. Сам по себе он
не доказывает, что физический Mac/GPU действительно выполнил модель. Это должен
закрыть production attestation layer, которого сейчас нет.

### Experimental finalized assignment и подписи transcript

`nir.execution_receipt` поддерживает два versioned assignment. Legacy
`FinalizedEvaluationAssignment` связывает network/genesis, candidate commitment
hash и ID, finalized height/state root, challenge, environment, suite, expiry и
точный отсортированный список evaluator IDs с ML-DSA-65 public keys. Явно
фиксируются baseline/candidate artifact и content hashes, adapter protocol,
safety-policy hash и commitment полного trusted authority set. Объект
принимается только с подписями более двух третей этого заранее доверенного
finality authority set и только внутри срока действия; вызывающий код не может
ослабить quorum параметром. Проверяющий также передаёт ожидаемые adapter protocol
и safety-policy hash из своей доверенной сетевой конфигурации: подпись quorum не
может сама назначить произвольную policy доверенной.

Каждый назначенный evaluator подписывает `SignedExecutionTranscript`, который
связывает assignment hash, собственный transcript hash, role, challenge,
environment, suite, candidate и итоговый execution bundle hash. Проверка требует
ровно две подписи — baseline и candidate — от каждого назначенного evaluator;
неназначенный, повторный или отсутствующий signer, подмена role/transcript/bundle
или истёкший assignment отклоняются.
Перед проверкой подписей bundle полностью пересобирается через `verify_bundle()`:
переданный вручную dataclass с несогласованным report/transcripts не считается
доказательством даже при самосогласованном новом `bundle_hash`.

Подписи используют существующие `ML-DSA-65`, consensus envelope codec и отдельные
домены `NIR_EVAL_ASSIGN_V1`/`NIR_EXEC_TRANSCRIPT_V1` через bounded verifier bridge.
Это доказывает ключ и точные подписанные байты. Отдельный
`nir.assignment_chain_proof` принимает извне доверенный light-client checkpoint,
исходный validator set и проверяемую историю handoff, затем использует
существующие `verifyFinalityProofChain()` и `verifyTransactionProof()`. Он
проверяет непрерывную цепочку подписанных finality headers до
`assignment.finalizedHeight`, совпадение `finalizedStateRoot` и Merkle inclusion
точного `progress-commitment` с теми же candidate/baseline artifact/content и
suite commitments. Из включённой транзакции Python повторно строит
`CandidateCommitment` и требует точного совпадения его hash с assignment.

Checkpoint, validator history, ожидаемые network/genesis не берутся из proof и
не становятся доверенными потому, что submitter положил их рядом: verifier
получает их из своей конфигурации/light-client store. Для checkpoint на genesis
проверяется точный genesis hash. Для `FinalizedEvaluationAssignmentV2` внешние
authority attestations удалены: его поля точно совпадают с protocol-v27 leaf, а
финальность даёт сама проверенная цепочка. `verify_execution_receipts()` принимает
v2 только вместе с matching exact-chain result и в диапазоне
`decisionHeight..expiresAtHeight`.

### Точная граница chain inclusion

Проверяющий должен различать три разные величины:

- `candidate_commitment_included=true`: точные байты admission-транзакции
  доказаны относительно `transactionsRoot` финализированного header;
- `chain_assignment_included=true` возможно только для v26+ membership proof
  consensus-native assignment к `evaluationAssignmentRoot`;
- `exact_assignment_included=true` возможно только для assignment v2 после
  проверки всех полей, evaluator-key witnesses, candidate transaction, трёх
  anchors, Merkle path и непрерывной finality; legacy assignment всегда non-exact.

Начиная с protocol v26 consensus канонически строит отдельное значение
`nir-evaluation-assignment-v1`: candidate/admission hashes, recipient, parents,
committed height, challenge seed и source height (`challengeEpoch` равен этому
height), а также точный ordered evaluator committee. Значения хранятся в
отдельном реестре активных назначений (до 4096 одновременных записей).
Запись добавляется при назначении challenge и атомарно удаляется вместе с
`progressCommitment` при принятии reward, expiry, fraud-cleanup назначенного
evaluator или cleanup после смены beacon committee. Это лимит одновременной
нагрузки, а не lifetime-лимит сети; при заполнении новые назначения fail closed
до завершения одного из активных.

Witness нужно получить и сохранить, пока assignment активен. После удаления
обычный full node не обязан уметь сгенерировать его заново, но уже сохранённый
proof остаётся проверяемым без срока давности против исторического
финализированного header. Поэтому клиент/оператор или архивный сервис обязан
хранить proof и header chain до конца своего dispute/archive срока; такой архив
не является новым trust root.
Sparse Merkle root реестра входит и в chain state, и в
`nir-finality-header-v3`; proof имеет фиксированную глубину 256 и лимит 32 KiB.
`verifyFinalizedEvaluationAssignmentProof()` сначала проверяет обычную finality
chain от внешнего trusted checkpoint/validator history, а затем membership path
к root из финализированного header. Protocol v24/v25 не получают нового поля и
сохраняют прежние block/header encodings.

Protocol v27 расширяет лист полями, необходимыми реальному runner: commitment
точного environment manifest, adapter protocol, выбранная safety policy, срок
действия, commitments исторических ключей оценщиков и hash состава
финализаторов. Environment manifest задаётся в genesis-конфигурации заранее;
без него v27 не активируется. Публичные ML-DSA-ключи не размножаются в каждом
листе: verifier получает их как witness, проверяет адрес и сравнивает компактный
key commitment. Размер одного assignment ограничен 64 KiB.

Чтобы не создавать невозможную самоссылку `stateRoot -> assignment ->
stateRoot`, v27 разделяет исходную финальность и включение: assignment называет
уже финализированные `sourceFinalityHeight/root`, а затем включается в Merkle-root
более позднего блока. Light client обязан проверить обе точки одной непрерывной
цепочкой finality proofs.

Старый Python-объект `FinalizedEvaluationAssignment` остаётся non-exact: его
внешние authority attestations не являются полями consensus leaf. Новый
`nir-finalized-evaluation-assignment-v2` заменяет двойную authority-модель
финальностью цепи и проверяется через chain-proof v3. Для длинной истории
protocol v28 и chain-proof v4 используют свежий quorum-certified checkpoint,
который фиксирует настоящий genesis hash и активный validator-set ID. Checkpoint
и набор валидаторов извлекаются только из подписанного witness-quorum trust
package. Оператор независимо закрепляет policy ID и хранит монотонные минимумы
sequence/height; произвольная пара checkpoint/validators от submitter в exact
path не принимается. Это честная weak-subjectivity граница.

`nir.replay_store` сохраняет доменно-разделённый ключ для каждой пары
assignment/evaluator/role. Полный набор receipt отмечается использованным одной
атомарной операцией под межпроцессной блокировкой; повреждение, расхождение копий,
подмена каталога, symlink и hardlink приводят к отказу. Гарантия относится только
к процессам с общим локальным store. Полный откат обеих локальных копий можно
обнаружить лишь при сравнении с checkpoint, закреплённым во внешнем доверенном
канале; распределённый exactly-once этим модулем не заявляется.

## Как считается проверка

Текущий evaluator нормализует текст через case-folding и пробелы, после чего:

- требует ровно один полный run от каждого из минимум трёх разных verifiers;
- требует одинаковое множество verifiers для baseline и candidate;
- выбирает majority answer для каждого case;
- запрещает регрессию любой family более чем на 500 bps;
- считает `generalityBps` как долю улучшенных families;
- считает `reproducibilityBps` как согласие отдельных runs с majority;
- отклоняет кандидата, если хотя бы один независимый run ошибся на любом
  `safety_critical` case;
- берёт median energy baseline и candidate; chain допускает reward только при
  `energyAttested === true` для всех runs;
- вычисляет positive gain, умножает его на generality, reproducibility, safety,
  novelty и ограниченный коэффициент энергоэффективности.

На chain reported gain дополнительно не может превышать величину нового
world-frontier delta. Бюджет reward epoch ограничен расписанием эмиссии и
остатком mining pool; распределение между принятыми claims пропорционально
score, с детерминированным распределением неделимого остатка. Сумма одного
reward не может превышать его заранее связанный bond.

## Защита от простых схем

### Переупаковка одного результата

Exact artifact, canonical content и behavior commitments нельзя принять
повторно. Baseline content должен совпасть с mapping уже известного baseline.
Frontier оплачивает только новый marginal delta, а pending claims резервируют
artifact/content/capabilities до maturity. Изменение имени архива, timestamps,
порядка tar или ключа получателя не создаёт новый canonical content.

**Пробел:** семантическая копия, слегка изменённые веса, общий training run,
разделение одной идеи на несколько пакетов и плагиат с иными commitments
автоматически не распознаются.

### Самопроверка и выбранные друзья

Committee выбирается после commitment; receipt должен быть подписан ровно
назначенными bonded evaluator keys. Одинаковые evaluator keys проверяют baseline
и candidate. Точный адрес submitter/recipient не может одновременно быть
зарегистрированным validator, beacon или evaluator address.

**Пробел:** разные ключи, operator IDs и юридические лица могут фактически
контролироваться одной компанией. Протокол не видит ownership, side payments,
общий cloud account или утечку hidden suite.

### Небезопасный майнинг

Chain принимает только approved `safetyPolicyHash`; safety score имеет floor
8000 bps, а одна ошибка в critical case в любом run — veto. Существенная
family regression запрещена. Небезопасный кандидат не должен получать progress
issuance; отдельный safety bounty финансируется bond/slashing, а не новой
эмиссией. Sandbox policy должна запрещать опасные side effects во время теста.

**Пробел:** текущий chain видит подписанное заключение, а не скрытые prompts или
физическое исполнение. Тесты не доказывают универсальную безопасность, модель
может распознать benchmark или sandbag, а dynamic dangerous-capability thresholds
и production quarantine workflow ещё требуют реализации и управления.

## Операторская процедура

До запуска публичного evaluator service оператор должен выполнить весь цикл:

1. Зарегистрировать отдельные operator identity и evaluator key, обеспечить
   требуемый bond; не использовать wallet submitter/recipient.
2. Развернуть full node/light client с закреплёнными network/genesis данными и
   принимать задания только после finalized committee assignment.
3. Получить кандидат не из произвольной ссылки в сообщении, а по manifest с
   `candidateId`; проверить размер, digest и admission proof до распаковки.
4. Создать ephemeral sandbox/VM/TEE из pinned image digest, без пользовательских
   секретов и с fail-closed egress policy.
5. Внутри неё пересчитать baseline/candidate canonical content и проверить
   suite/policy commitments и challenge freshness.
6. Выполнить одинаковый schedule baseline/candidate; сохранить полные outputs,
   failures и измерения. Timeout/crash/OOM — результат run, а не повод вручную
   заменить ответ.
7. Локально пересчитать bundle/report. Не подписывать receipt, если любой hash,
   case count, critical safety result или attestation расходится.
8. Сопоставить receipt с `candidateId`, network, epoch, recipient и назначенным
   committee, после чего подписать только один результат.
9. Хранить evidence до конца escrow/fraud retention window и публиковать только
   разрешённую часть; приватные задачи и credentials не писать в обычные логи.
10. После settlement уничтожить временные ключи/API credentials и проверить,
    что receipt, bundle commitment и chain outcome совпали.

## Незакрытые условия до честного публичного запуска

1. Реализовать и независимо проверить macOS miner UI, package builder,
   submission gateway и adapter conformance kit.
2. Реализовать настоящие isolated runners/TEE attestations и подпись каждого
   execution transcript, а не только итогового chain receipt.
3. Определить доверенную и воспроизводимую energy metering scheme.
4. Опубликовать versioned hidden-task lifecycle: авторство, commit/reveal,
   rotation, утечки, retirement и аудит качества.
5. Ввести admission и disclosure rules для реальной независимости операторов;
   ключевая уникальность недостаточна.
6. Определить безопасную доставку приватных моделей, retention, удаление,
   incident response и право на аудит без раскрытия weights в chain.
7. Добавить semantic-similarity/lineage dispute process; не выдавать exact-hash
   дедупликацию за защиту от плагиата.
8. Связать chain evaluation с verifiable runner attestations и сделать
   объективно проверяемыми ложное исполнение и energy fraud. Сейчас escrow
   объективно наказывает только полный committee за конфликтующие receipts.
9. Провести внешние security/economic audits и многосайтовую valueless testnet.

Пока эти пункты не закрыты, корректная формулировка для пользователя —
«локальная демонстрация проверочного протокола», а не «готовый майнинг NIR».

## Код и связанные документы

- `nir/model_content.py` — canonical model content;
- `nir/runner.py` — commitment, transcript и execution bundle;
- `nir/evaluator.py` — метрики и critical safety veto;
- `nir/memory.py` — lineage и world frontier;
- `nir/model.py` — детерминированный score и простая emission ledger model;
- `blockchain/chain.mjs` — admission, randomness, committee, receipt, reward и escrow;
- [Canonical model content](model-content.md), [Safety](safety.md),
  [Protocol](protocol.md), [Reward escrow](progress-reward-escrow.md) и
  [Economic-gaming boundary](progress-economic-gaming-audit.md).
