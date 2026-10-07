// An HTTP submission response is not a finality proof. Only the verified
// transaction-history workflow may present an operation as confirmed.
export function submissionStatus(result) {
  if (result?.status === "queued") {
    return "Принято в очередь, ждите проверенного подтверждения.";
  }
  return "Ответ узла получен, ждите проверенного подтверждения в истории операций.";
}
