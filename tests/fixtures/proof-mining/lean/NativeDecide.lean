import Task

theorem helper : (10 : Nat) + 10 = 20 := by native_decide

theorem NIR.solution : NIR.statement := fun _ => (fun _ => rfl) helper
