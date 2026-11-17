def branch(value):  # cf:branch
    if value > 0:
        return "pos"
    elif value == 0:
        return "zero"
    else:
        return "neg"


def matched(value):  # cf:match
    match value:
        case 0:
            return "zero"
        case 1 | 2:
            return "small"
        case _ if value > 10:
            return "big"
        case _:
            return "other"


def loop_for(items):  # cf:for
    total = 0
    for item in items:
        if item < 0:
            break
        if item == 0:
            continue
        total += item
    else:
        total += 1
    return total


def loop_while(n):  # cf:while
    while n > 0:
        n -= 1
        if n == 3:
            continue
        if n == 1:
            break
    else:
        n = -1
    return n


def attempt(value):  # cf:try
    try:
        if value < 0:
            raise ValueError("no")
        return value
    except ValueError:
        return 0
    else:
        return 1
    finally:
        value = 0


def opened(path):  # cf:with
    with path as handle:
        return handle.read()


async def async_opened(path):  # cf:asyncwith
    async with path as handle:
        data = await handle.read()
        return data


def gen(items):  # cf:yield
    for item in items:
        yield item


async def async_items(items):  # cf:asyncfor
    total = 0
    async for item in items:
        total += await item
    return total


def checked(value):  # cf:assert
    assert value > 0
    return value


def after_return():  # cf:dead
    return 1
    return 2


def nested(value):  # cf:nested
    def inner(times):
        return value * times

    scale = lambda factor: inner(factor)
    return scale(2)
