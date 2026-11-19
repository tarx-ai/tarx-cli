import Base

# Deterministic parallel tree-sum of 2^d ones. Result is 65536.
# `!` marks the GPU/parallel lane: Metal on macOS, CUDA on Linux, CPU cores
# when no GPU toolkit is present. Force CPU with `+RTS --gpu off`.
def parallel_sum(+d: Nat) -> U32:
  match d:
    case 0n:
      1
    case 1n+p:
      a b = parallel_sum(p) parallel_sum(p)
      (a + b : U32)

def main() -> IO(Unit):
  result = parallel_sum!(16n)
  IO.print(U32.show(result))
