-- Library for network-generated proof-mining tasks (docs/proof-mining.md §7.2).
-- A task is `def NIR.statement : Prop := NIR.Clique.HasClique n k g`; a
-- solution proves either `NIR.statement` or `¬ NIR.statement`.
namespace NIR.Clique

/-- Vertex `i` of a graph on `n` vertices is adjacent to `j` when bit `i * n + j` of `g` is set. -/
def adj (n g i j : Nat) : Bool := g.testBit (i * n + j)

/-- The bits of `x` mark a clique: every two distinct marked vertices are adjacent. -/
def IsClique (n g x : Nat) : Prop :=
  ∀ i, i < n → ∀ j, j < n → i ≠ j → x.testBit i = true → x.testBit j = true → adj n g i j = true

/-- Number of marked vertices among the first `n`. -/
def size : Nat → Nat → Nat
  | 0, _ => 0
  | n + 1, x => size n x + (x >>> n) % 2

/-- The graph has a clique with at least `k` vertices. -/
def HasClique (n k g : Nat) : Prop := ∃ x, x < 2 ^ n ∧ IsClique n g x ∧ k ≤ size n x

instance (n g x : Nat) : Decidable (IsClique n g x) := by unfold IsClique; infer_instance

/-- Refuting a clique reduces to a bounded check over every vertex set. -/
theorem not_hasClique (n k g : Nat)
    (h : ∀ x, x < 2 ^ n → ¬ (IsClique n g x ∧ k ≤ size n x)) : ¬ HasClique n k g :=
  fun ⟨x, hx, hc, hk⟩ => h x hx ⟨hc, hk⟩

end NIR.Clique
