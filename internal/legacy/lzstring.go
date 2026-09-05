package legacy

import (
	"errors"
	"unicode/utf16"
)

type bitReader struct {
	values   []uint16
	value    int
	position int
	index    int
}

func newBitReader(values []uint16) *bitReader {
	if len(values) == 0 {
		return &bitReader{}
	}
	return &bitReader{values: values, value: int(values[0]) - 32, position: 16384, index: 1}
}

func (r *bitReader) read(bits int) (int, error) {
	result, power, maxPower := 0, 1, 1<<bits
	for power != maxPower {
		if r.position == 0 || r.index > len(r.values) {
			return 0, errors.New("truncated lz-string stream")
		}
		bit := r.value & r.position
		r.position >>= 1
		if r.position == 0 {
			r.position = 16384
			if r.index < len(r.values) {
				r.value = int(r.values[r.index]) - 32
			}
			r.index++
		}
		if bit > 0 {
			result |= power
		}
		power <<= 1
	}
	return result, nil
}

func decompressUTF16(values []uint16) (string, error) {
	if len(values) == 0 {
		return "", nil
	}
	r := newBitReader(values)
	next, err := r.read(2)
	if err != nil {
		return "", err
	}
	var first uint16
	switch next {
	case 0:
		v, e := r.read(8)
		if e != nil {
			return "", e
		}
		first = uint16(v)
	case 1:
		v, e := r.read(16)
		if e != nil {
			return "", e
		}
		first = uint16(v)
	case 2:
		return "", nil
	default:
		return "", errors.New("invalid lz-string prefix")
	}
	dictionary := map[int][]uint16{0: nil, 1: nil, 2: nil, 3: {first}}
	dictSize, numBits, enlargeIn := 4, 3, 4
	w := []uint16{first}
	result := append([]uint16(nil), w...)
	for {
		code, err := r.read(numBits)
		if err != nil {
			return "", err
		}
		switch code {
		case 0:
			v, e := r.read(8)
			if e != nil {
				return "", e
			}
			dictionary[dictSize] = []uint16{uint16(v)}
			code = dictSize
			dictSize++
			enlargeIn--
		case 1:
			v, e := r.read(16)
			if e != nil {
				return "", e
			}
			dictionary[dictSize] = []uint16{uint16(v)}
			code = dictSize
			dictSize++
			enlargeIn--
		case 2:
			return string(utf16.Decode(result)), nil
		}
		if enlargeIn == 0 {
			enlargeIn = 1 << numBits
			numBits++
		}
		entry, ok := dictionary[code]
		if !ok {
			if code != dictSize || len(w) == 0 {
				return "", errors.New("invalid lz-string dictionary reference")
			}
			entry = append(append([]uint16(nil), w...), w[0])
		}
		result = append(result, entry...)
		if len(entry) == 0 {
			return "", errors.New("empty lz-string dictionary entry")
		}
		added := append(append([]uint16(nil), w...), entry[0])
		dictionary[dictSize] = added
		dictSize++
		enlargeIn--
		w = append([]uint16(nil), entry...)
		if enlargeIn == 0 {
			enlargeIn = 1 << numBits
			numBits++
		}
	}
}
