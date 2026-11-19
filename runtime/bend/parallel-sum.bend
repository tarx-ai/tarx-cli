import Base

# Deterministic parallel tree-sum of 2^d ones. Depth d is argv[1] (log2 size),
# default 16. Times the `!` call with IO.now (monotonic milliseconds).
# `!` is the GPU/parallel lane: Metal on macOS, CUDA on Linux, CPU cores
# when no GPU toolkit is present. Force CPU with `+RTS --gpu off`.
def parallel_sum(+d: Nat) -> U32:
  match d:
    case 0n:
      1
    case 1n+p:
      a b = parallel_sum(p) parallel_sum(p)
      (a + b : U32)

def parsed_depth(parsed: Maybe<&2, Nat>) -> Nat:
  match parsed:
    case Some{d}:
      d
    case None{}:
      16n

def depth_from(args: List<String>) -> Nat:
  match args:
    case _ <> s <> Nil{}:
      parsed_depth(Nat.read(s))
    case _:
      16n

def main() -> IO(Unit):
  do IO<Unit>:
    args : List<String> <- IO.args()
    d : Nat = depth_from(args)
    t0 : Nat <- IO.now()
    result : U32 = parallel_sum!(d)
    t1 : Nat <- IO.now()
    IO.print("RESULT " ++ U32.show(result))
    IO.print("COMPUTE_MS " ++ Nat.show(Nat.sub(t1, t0)))
