def cached(fn):
    return fn


@cached
def decorated(value):
    def inner(times):
        return value * times

    scale = lambda factor: inner(factor)
    return scale(2)
