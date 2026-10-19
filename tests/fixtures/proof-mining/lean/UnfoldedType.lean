import Task

-- Proves the unfolded statement instead of naming NIR.statement.
theorem NIR.solution : ∀ n : Nat, Nat.add n Nat.zero = n := fun _ => rfl
